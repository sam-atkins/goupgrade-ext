/**
 * Upgrades Go projects: bumps the toolchain version in go.mod and updates
 * all module dependencies via go get -u all.
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

/** Model definition for upgrading Go projects. */
export const model = {
  type: "@dismal_swamper/goupgrade",
  version: "2026.09.19.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.09.19.1",
      description: "Version bump, no schema changes",
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
  },
};
