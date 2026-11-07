import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { model } from "./goupgrade.ts";

function fakeGoMod(goVersion: string): string {
  return `module example.com/project

go ${goVersion}

require example.com/dep v1.0.0
`;
}

function updateGoMod(state: "before" | "after"): string {
  const versions = state === "before"
    ? { changed: "v1.2.3", single: "v1.0.0", tools: "v0.1.0" }
    : { changed: "v1.3.0", single: "v1.1.0", tools: "v0.2.0" };
  return `module example.com/project

go 1.26.2

require example.com/single ${versions.single}

require (
    example.com/changed ${versions.changed} // indirect
    example.com/unchanged v2.0.0
    golang.org/x/tools ${versions.tools}
)
`;
}

function stubDenoCommand(exitCode: number, onGoGet?: () => void) {
  const invocations: { cmd: string; args: string[]; cwd?: string }[] = [];
  const originalCommand = Deno.Command;
  class FakeCommand {
    constructor(
      public cmd: string,
      public options: { args?: string[]; cwd?: string },
    ) {
      invocations.push({ cmd, args: options.args ?? [], cwd: options.cwd });
    }
    output() {
      if (this.options.args?.[0] === "get") onGoGet?.();
      return Promise.resolve({
        code: exitCode,
        success: exitCode === 0,
        stdout: new TextEncoder().encode(""),
        stderr: new TextEncoder().encode("go get: something failed"),
      });
    }
  }
  (Deno as unknown as Record<string, unknown>).Command = FakeCommand;
  return {
    invocations,
    restore: () => {
      (Deno as unknown as Record<string, unknown>).Command = originalCommand;
    },
  };
}

function stubReadTextFile(read: (path: string) => string) {
  const originalReadTextFile = Deno.readTextFile;
  (Deno as unknown as Record<string, unknown>).readTextFile = (path: string) =>
    Promise.resolve(read(path));
  return {
    restore: () => {
      (Deno as unknown as Record<string, unknown>).readTextFile =
        originalReadTextFile;
    },
  };
}

function mockWriteResource() {
  const writes: {
    specName: string;
    name: string;
    data: Record<string, unknown>;
  }[] = [];
  return {
    writeResource: async (
      specName: string,
      name: string,
      data: Record<string, unknown>,
    ) => {
      writes.push({ specName, name, data });
      return { name };
    },
    writes,
  };
}

function makeContext() {
  const writeResource = mockWriteResource();
  return {
    writeResource,
    context: {
      globalArgs: { workingDirectory: "/tmp/project" },
      writeResource: writeResource.writeResource,
    },
  };
}

Deno.test("goupgrade - bump runs go get go@<version>", async () => {
  const commands = stubDenoCommand(0);
  const reads = stubReadTextFile(() => fakeGoMod("1.26.2"));
  const { writeResource, context } = makeContext();

  try {
    await model.methods.bump.execute({ version: "1.26.6" }, context);

    const get = commands.invocations.find((i) => i.args[0] === "get");
    assertEquals(get?.args, ["get", "go@1.26.6"]);
    assertEquals(get?.cwd, "/tmp/project");
    assertEquals(
      writeResource.writes[0].data.command,
      "go get go@1.26.6 (in /tmp/project)",
    );
  } finally {
    commands.restore();
    reads.restore();
  }
});

Deno.test("goupgrade - bump accepts a go-prefixed version", async () => {
  const commands = stubDenoCommand(0);
  const reads = stubReadTextFile(() => fakeGoMod("1.26.2"));
  const { context } = makeContext();

  try {
    await model.methods.bump.execute({ version: "go1.26.6" }, context);

    const get = commands.invocations.find((i) => i.args[0] === "get");
    assertEquals(get?.args, ["get", "go@1.26.6"]);
  } finally {
    commands.restore();
    reads.restore();
  }
});

Deno.test("goupgrade - bump trims whitespace around the version", async () => {
  const commands = stubDenoCommand(0);
  const reads = stubReadTextFile(() => fakeGoMod("1.26.2"));
  const { context } = makeContext();

  try {
    await model.methods.bump.execute({ version: " 1.26.6\n" }, context);

    const get = commands.invocations.find((i) => i.args[0] === "get");
    assertEquals(get?.args, ["get", "go@1.26.6"]);
  } finally {
    commands.restore();
    reads.restore();
  }
});

Deno.test("goupgrade - bump supports latest", async () => {
  let goMod = fakeGoMod("1.26.2");
  const commands = stubDenoCommand(0, () => {
    goMod = fakeGoMod("1.26.7");
  });
  const reads = stubReadTextFile((path) =>
    path.endsWith("go.mod") ? goMod : (() => {
      throw new Error(`unexpected read: ${path}`);
    })()
  );
  const { writeResource, context } = makeContext();

  try {
    await model.methods.bump.execute({ version: "latest" }, context);

    const get = commands.invocations.find((i) => i.args[0] === "get");
    assertEquals(get?.args, ["get", "go@latest"]);
    assertEquals(writeResource.writes[0].data.previousVersion, "go1.26.2");
    assertEquals(writeResource.writes[0].data.newVersion, "go1.26.7");
  } finally {
    commands.restore();
    reads.restore();
  }
});

Deno.test("goupgrade - bump reports actual go.mod versions around the bump", async () => {
  let goMod = fakeGoMod("1.26.2");
  const commands = stubDenoCommand(0, () => {
    goMod = fakeGoMod("1.26.6");
  });
  const reads = stubReadTextFile((path) =>
    path.endsWith("go.mod") ? goMod : (() => {
      throw new Error(`unexpected read: ${path}`);
    })()
  );
  const { writeResource, context } = makeContext();

  try {
    await model.methods.bump.execute({ version: "1.26.6" }, context);

    assertEquals(writeResource.writes[0].data.previousVersion, "go1.26.2");
    assertEquals(writeResource.writes[0].data.newVersion, "go1.26.6");
    assertEquals(writeResource.writes[0].data.success, true);
  } finally {
    commands.restore();
    reads.restore();
  }
});

Deno.test("goupgrade - bump rejects a malformed multi-line version", async () => {
  const commands = stubDenoCommand(0);
  const reads = stubReadTextFile(() => fakeGoMod("1.26.2"));
  const { context } = makeContext();

  try {
    await assertRejects(
      () =>
        model.methods.bump.execute(
          { version: "1.26.6\n1.26.6\n1.26.6" },
          context,
        ),
      Error,
      "invalid Go version",
    );

    assertEquals(
      commands.invocations.filter((i) => i.args[0] === "get").length,
      0,
    );
  } finally {
    commands.restore();
    reads.restore();
  }
});

Deno.test("goupgrade - update runs go get -u all in the working directory", async () => {
  const commands = stubDenoCommand(0);
  const reads = stubReadTextFile((path) =>
    path.endsWith("go.mod") ? updateGoMod("before") : (() => {
      throw new Error(`unexpected read: ${path}`);
    })()
  );
  const { writeResource, context } = makeContext();

  try {
    await model.methods.update.execute({}, context);

    const get = commands.invocations.find((i) => i.args[0] === "get");
    assertEquals(get?.args, ["get", "-u", "all"]);
    assertEquals(get?.cwd, "/tmp/project");
    assertEquals(
      writeResource.writes[0].data.command,
      "go get -u all (in /tmp/project)",
    );
    assertEquals(writeResource.writes[0].data.success, true);
  } finally {
    commands.restore();
    reads.restore();
  }
});

Deno.test("goupgrade - update reports the require diff as changed modules", async () => {
  let goMod = updateGoMod("before");
  const commands = stubDenoCommand(0, () => {
    goMod = updateGoMod("after");
  });
  const reads = stubReadTextFile((path) =>
    path.endsWith("go.mod") ? goMod : (() => {
      throw new Error(`unexpected read: ${path}`);
    })()
  );
  const { writeResource, context } = makeContext();

  try {
    await model.methods.update.execute({}, context);

    assertEquals(writeResource.writes[0].data.changedModules, [
      {
        module: "example.com/changed",
        previousVersion: "v1.2.3",
        newVersion: "v1.3.0",
      },
      {
        module: "example.com/single",
        previousVersion: "v1.0.0",
        newVersion: "v1.1.0",
      },
      {
        module: "golang.org/x/tools",
        previousVersion: "v0.1.0",
        newVersion: "v0.2.0",
      },
    ]);
  } finally {
    commands.restore();
    reads.restore();
  }
});

Deno.test("goupgrade - update diff ignores non-require directives", async () => {
  let goMod = updateGoMod("before");
  const commands = stubDenoCommand(0, () => {
    goMod = updateGoMod("before")
      .replace(
        "example.com/unchanged v2.0.0",
        "example.com/unchanged v2.0.0\n    // v9.9.9 comment",
      ) + "\nretract v1.0.0\nexclude example.com/bad v1.0.0\n";
  });
  const reads = stubReadTextFile((path) =>
    path.endsWith("go.mod") ? goMod : (() => {
      throw new Error(`unexpected read: ${path}`);
    })()
  );
  const { writeResource, context } = makeContext();

  try {
    await model.methods.update.execute({}, context);

    assertEquals(writeResource.writes[0].data.changedModules, []);
  } finally {
    commands.restore();
    reads.restore();
  }
});

Deno.test("goupgrade - update defaults to the current working directory", async () => {
  const commands = stubDenoCommand(0);
  const reads = stubReadTextFile((path) =>
    path.endsWith("go.mod") ? updateGoMod("before") : (() => {
      throw new Error(`unexpected read: ${path}`);
    })()
  );
  const writeResource = mockWriteResource();

  try {
    await model.methods.update.execute({}, {
      globalArgs: {},
      writeResource: writeResource.writeResource,
    });

    const get = commands.invocations.find((i) => i.args[0] === "get");
    assertEquals(get?.cwd, Deno.cwd());
  } finally {
    commands.restore();
    reads.restore();
  }
});

Deno.test("goupgrade - update writes failure record then throws on go get failure", async () => {
  const commands = stubDenoCommand(1);
  const reads = stubReadTextFile((path) =>
    path.endsWith("go.mod") ? updateGoMod("before") : (() => {
      throw new Error(`unexpected read: ${path}`);
    })()
  );
  const { writeResource, context } = makeContext();

  try {
    await assertRejects(
      () => model.methods.update.execute({}, context),
      Error,
      "go get -u all failed (exit 1): go get: something failed",
    );

    assertEquals(writeResource.writes.length, 1);
    assertEquals(writeResource.writes[0].data.exitCode, 1);
    assertEquals(writeResource.writes[0].data.success, false);
    assertEquals(writeResource.writes[0].data.changedModules, []);
  } finally {
    commands.restore();
    reads.restore();
  }
});

Deno.test("goupgrade - bump writes failure record then throws on go get failure", async () => {
  const commands = stubDenoCommand(1);
  const reads = stubReadTextFile(() => fakeGoMod("1.26.2"));
  const { writeResource, context } = makeContext();

  try {
    await assertRejects(
      () => model.methods.bump.execute({ version: "1.26.6" }, context),
      Error,
      "go get go@1.26.6 failed (exit 1): go get: something failed",
    );

    assertEquals(writeResource.writes.length, 1);
    assertEquals(writeResource.writes[0].data.exitCode, 1);
    assertEquals(writeResource.writes[0].data.success, false);
    assertEquals(writeResource.writes[0].data.previousVersion, "go1.26.2");
  } finally {
    commands.restore();
    reads.restore();
  }
});

function fakeDockerfile(tag: string): string {
  return `FROM golang:${tag} AS tools

FROM golang:${tag} AS builder
`;
}

function stubWriteTextFile() {
  const writes: Record<string, string> = {};
  const originalWriteTextFile = Deno.writeTextFile;
  (Deno as unknown as Record<string, unknown>).writeTextFile = (
    path: string,
    content: string,
  ) => {
    writes[path] = content;
    return Promise.resolve();
  };
  return {
    writes,
    restore: () => {
      (Deno as unknown as Record<string, unknown>).writeTextFile =
        originalWriteTextFile;
    },
  };
}

function stubProjectFiles(goMod: string, dockerfile: string) {
  return stubReadTextFile((path) => {
    if (path.endsWith("go.mod")) return goMod;
    if (path.endsWith("Dockerfile")) return dockerfile;
    throw new Error(`unexpected read: ${path}`);
  });
}

Deno.test("goupgrade - sync-dockerfile rewrites golang base image tags to the go.mod minor version", async () => {
  const reads = stubProjectFiles(
    fakeGoMod("1.27.3"),
    fakeDockerfile("1.26-alpine"),
  );
  const files = stubWriteTextFile();
  const { writeResource, context } = makeContext();

  try {
    const result = await model.methods["sync-dockerfile"].execute({}, context);

    assertEquals(
      files.writes["/tmp/project/Dockerfile"],
      fakeDockerfile("1.27-alpine"),
    );
    assertEquals(writeResource.writes.length, 1);
    assertEquals(writeResource.writes[0].specName, "dockerfile-sync");
    assertEquals(writeResource.writes[0].name, "current");
    assertEquals(writeResource.writes[0].data, {
      goVersion: "1.27.3",
      syncedTo: "1.27",
      previousVersions: ["1.26"],
      changed: true,
      success: true,
    });
    assertEquals(result.dataHandles!.length, 1);
  } finally {
    reads.restore();
    files.restore();
  }
});

Deno.test("goupgrade - sync-dockerfile collapses patch-pinned tags to the minor tag", async () => {
  const dockerfile = "FROM golang:1.26.10-alpine AS builder\n";
  const reads = stubProjectFiles(fakeGoMod("1.27.3"), dockerfile);
  const files = stubWriteTextFile();
  const { writeResource, context } = makeContext();

  try {
    await model.methods["sync-dockerfile"].execute({}, context);

    assertEquals(
      files.writes["/tmp/project/Dockerfile"],
      "FROM golang:1.27-alpine AS builder\n",
    );
    assertEquals(writeResource.writes[0].data.previousVersions, ["1.26.10"]);
    assertEquals(writeResource.writes[0].data.changed, true);
  } finally {
    reads.restore();
    files.restore();
  }
});

Deno.test("goupgrade - sync-dockerfile does not write when the Dockerfile is already in sync", async () => {
  const reads = stubProjectFiles(
    fakeGoMod("1.27.3"),
    fakeDockerfile("1.27-alpine"),
  );
  const files = stubWriteTextFile();
  const { writeResource, context } = makeContext();

  try {
    await model.methods["sync-dockerfile"].execute({}, context);

    assertEquals(files.writes["/tmp/project/Dockerfile"], undefined);
    assertEquals(writeResource.writes[0].data.changed, false);
    assertEquals(writeResource.writes[0].data.success, true);
  } finally {
    reads.restore();
    files.restore();
  }
});

Deno.test("goupgrade - sync-dockerfile writes failure record then throws when no golang base image is present", async () => {
  const reads = stubProjectFiles(fakeGoMod("1.27.3"), "FROM alpine:3.21\n");
  const files = stubWriteTextFile();
  const { writeResource, context } = makeContext();

  try {
    await assertRejects(
      () => model.methods["sync-dockerfile"].execute({}, context),
      Error,
      "no golang base image found in /tmp/project/Dockerfile",
    );

    assertEquals(writeResource.writes.length, 1);
    assertEquals(writeResource.writes[0].specName, "dockerfile-sync");
    assertEquals(writeResource.writes[0].data.success, false);
    assertEquals(writeResource.writes[0].data.previousVersions, []);
    assertEquals(files.writes["/tmp/project/Dockerfile"], undefined);
  } finally {
    reads.restore();
    files.restore();
  }
});
