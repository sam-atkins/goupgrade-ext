/**
 * Upgrades Go projects: bumps the toolchain version in go.mod, updates
 * all module dependencies via go get -u all, and syncs the Dockerfile's
 * golang base image tag with the go directive.
 *
 * @module
 */
import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  workingDirectory: z.string().optional(),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

async function readGoDirective(workdir: string): Promise<string> {
  try {
    const goMod = await Deno.readTextFile(`${workdir}/go.mod`);
    const match = goMod.match(/^go\s+(\S+)/m);
    return match ? `go${match[1]}` : "unknown";
  } catch {
    return "unknown";
  }
}

function parseRequiredModules(goMod: string): Map<string, string> {
  const versions = new Map<string, string>();
  let inRequireBlock = false;
  for (const line of goMod.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("require (")) {
      inRequireBlock = true;
      continue;
    }
    if (inRequireBlock && trimmed.startsWith(")")) {
      inRequireBlock = false;
      continue;
    }
    if (trimmed.startsWith("//")) continue;
    const candidate = inRequireBlock
      ? trimmed
      : trimmed.startsWith("require ")
      ? trimmed.slice("require ".length)
      : "";
    const match = candidate.match(/^(\S+)\s+(v\S+)/);
    if (match) versions.set(match[1], match[2]);
  }
  return versions;
}

const ChangedModuleSchema = z.object({
  module: z.string(),
  previousVersion: z.string(),
  newVersion: z.string(),
});

const UpdateOutputSchema = z.object({
  command: z.string(),
  exitCode: z.number(),
  success: z.boolean(),
  changedModules: z.array(ChangedModuleSchema),
});

function diffRequiredModules(
  previous: Map<string, string>,
  next: Map<string, string>,
): Array<z.infer<typeof ChangedModuleSchema>> {
  return [...next.entries()]
    .filter(([module, version]) => previous.get(module) !== version)
    .map(([module, newVersion]) => ({
      module,
      previousVersion: previous.get(module) ?? "none",
      newVersion,
    }))
    .sort((a, b) => a.module.localeCompare(b.module));
}

const OutputSchema = z.object({
  previousVersion: z.string(),
  newVersion: z.string(),
  command: z.string(),
  exitCode: z.number(),
  success: z.boolean(),
});

const GOLANG_TAG_PATTERN = /golang:(\d+\.\d+(?:\.\d+)?)/g;

/** Extract the version from the go directive in go.mod contents. */
function goModGoVersion(goMod: string): string {
  const match = goMod.match(/^go\s+(\d+\.\d+(?:\.\d+)?)/m);
  if (!match) {
    throw new Error("no go directive found in go.mod");
  }
  return match[1];
}

/** Strip a full Go version to its major.minor form, e.g. "1.27.3" -> "1.27". */
function minorVersion(version: string): string {
  const [major, minor] = version.split(".");
  return `${major}.${minor}`;
}

type SyncResult = {
  content: string;
  previousVersions: string[];
  changed: boolean;
};

/** Rewrite golang base image tags in a Dockerfile to the given minor version. */
function syncGolangFromLines(dockerfile: string, minor: string): SyncResult {
  const previousVersions = [
    ...new Set(
      [...dockerfile.matchAll(GOLANG_TAG_PATTERN)].map((m) => m[1]),
    ),
  ];
  const content = dockerfile.replace(GOLANG_TAG_PATTERN, `golang:${minor}`);
  return { content, previousVersions, changed: content !== dockerfile };
}

const SyncDockerfileOutputSchema = z.object({
  goVersion: z.string(),
  syncedTo: z.string(),
  previousVersions: z.array(z.string()),
  changed: z.boolean(),
  success: z.boolean(),
});

/** Model definition for upgrading Go projects. */
export const model = {
  type: "@dismal_swamper/goupgrade",
  version: "2026.11.07.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.09.19.1",
      description: "Version bump, no schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.11.07.1",
      description:
        "Add sync-dockerfile method and dockerfile-sync resource, no changes to existing resources",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    result: {
      description: "Result of the Go version bump",
      schema: OutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    update: {
      description: "Result of the go get -u all dependency update",
      schema: UpdateOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "dockerfile-sync": {
      description:
        "Result of syncing the Dockerfile golang base image with go.mod",
      schema: SyncDockerfileOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    bump: {
      description: "Run go get go@<version> to bump the Go toolchain version",
      arguments: z.object({
        version: z.string().describe(
          "Go version to bump to (e.g. 1.23.4), or 'latest'",
        ),
      }),
      execute: async (
        args: { version: string },
        context: {
          globalArgs: GlobalArgs;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        const workdir = context.globalArgs.workingDirectory || Deno.cwd();
        const bareVersion = args.version.replace(/^go/, "").trim();
        if (!/^(\d+\.\d+(\.\d+)?|latest)$/.test(bareVersion)) {
          throw new Error(
            `invalid Go version: ${JSON.stringify(args.version)}`,
          );
        }
        const targetSpec = `go@${bareVersion}`;
        const previousVersion = await readGoDirective(workdir);

        const cmd = new Deno.Command("go", {
          args: ["get", targetSpec],
          cwd: workdir,
        });

        const { code, stderr } = await cmd.output();

        const newVersion = code === 0
          ? await readGoDirective(workdir)
          : targetSpec;
        const handle = await context.writeResource("result", "current", {
          previousVersion,
          newVersion,
          command: `go get ${targetSpec} (in ${workdir})`,
          exitCode: code,
          success: code === 0,
        });

        if (code !== 0) {
          const goGetError = new TextDecoder().decode(stderr).trim();
          throw new Error(
            `go get ${targetSpec} failed (exit ${code})${
              goGetError ? `: ${goGetError}` : ""
            }`,
          );
        }

        return { dataHandles: [handle] };
      },
    },
    update: {
      description: "Run go get -u all to update all Go module dependencies",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: {
          globalArgs: GlobalArgs;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        const workdir = context.globalArgs.workingDirectory || Deno.cwd();
        const goModBefore = await Deno.readTextFile(`${workdir}/go.mod`);
        const previous = parseRequiredModules(goModBefore);

        const cmd = new Deno.Command("go", {
          args: ["get", "-u", "all"],
          cwd: workdir,
        });

        const { code, stderr } = await cmd.output();

        const goModAfter = code === 0
          ? await Deno.readTextFile(`${workdir}/go.mod`)
          : goModBefore;
        const changedModules = diffRequiredModules(
          previous,
          parseRequiredModules(goModAfter),
        );

        const handle = await context.writeResource("update", "current", {
          command: `go get -u all (in ${workdir})`,
          exitCode: code,
          success: code === 0,
          changedModules,
        });

        if (code !== 0) {
          const goGetError = new TextDecoder().decode(stderr).trim();
          throw new Error(
            `go get -u all failed (exit ${code})${
              goGetError ? `: ${goGetError}` : ""
            }`,
          );
        }

        return { dataHandles: [handle] };
      },
    },
    "sync-dockerfile": {
      description:
        "Sync the Dockerfile's golang base image tag with the go directive in go.mod",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: {
          globalArgs: GlobalArgs;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        const workdir = context.globalArgs.workingDirectory || Deno.cwd();
        const goMod = await Deno.readTextFile(`${workdir}/go.mod`);
        const goVersion = goModGoVersion(goMod);
        const minor = minorVersion(goVersion);

        const dockerfilePath = `${workdir}/Dockerfile`;
        const dockerfile = await Deno.readTextFile(dockerfilePath);
        const { content, previousVersions, changed } = syncGolangFromLines(
          dockerfile,
          minor,
        );

        if (previousVersions.length === 0) {
          await context.writeResource("dockerfile-sync", "current", {
            goVersion,
            syncedTo: minor,
            previousVersions,
            changed: false,
            success: false,
          });
          throw new Error(`no golang base image found in ${dockerfilePath}`);
        }

        if (changed) {
          await Deno.writeTextFile(dockerfilePath, content);
        }

        const handle = await context.writeResource(
          "dockerfile-sync",
          "current",
          {
            goVersion,
            syncedTo: minor,
            previousVersions,
            changed,
            success: true,
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
