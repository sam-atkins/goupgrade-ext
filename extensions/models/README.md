# @dismal_swamper/goupgrade

Upgrades Go projects: bumps the Go toolchain version in `go.mod` via
`go get go@<version>`, updates all module dependencies via
`go get -u all`, and syncs the `Dockerfile`'s `golang` base image tag with the
go directive. Each method records what changed — the previous and new Go
versions, the full per-module require diff, or the Dockerfile tag sync —
before reporting success or failure.

## Installation

```sh
swamp extension install @dismal_swamper/goupgrade
```

## Usage

Create a model definition, optionally pointing it at the Go project with the
`workingDirectory` global argument (defaults to the current working directory):

```bash
swamp model create @dismal_swamper/goupgrade my-go-upgrade \
  --global-arg workingDirectory=/Users/sam/code/my-project
```

Bump the Go toolchain version:

```bash
swamp model method run my-go-upgrade bump --input version=1.26.6
```

The `bump` method accepts a plain version (`1.26.6`), a `go`-prefixed version
(`go1.26.6`), or `latest`. Update all module dependencies to their latest minor
or patch releases:

```bash
swamp model method run my-go-upgrade update
```

After a `bump`, sync the `Dockerfile`'s `golang` base image tags with the go
directive in `go.mod`:

```bash
swamp model method run my-go-upgrade sync-dockerfile
```

`sync-dockerfile` rewrites every `golang:<version>` base image tag to the
go directive's major.minor form (e.g. `go 1.27.3` turns
`golang:1.26-alpine` into `golang:1.27-alpine`), is a no-op when the
Dockerfile is already in sync, and fails when no `golang` base image is
present.

On any failure, a failure record is written to the corresponding resource
before the method throws, so the exact command, exit code, and stderr are
captured in the data model.

## Output

The `result` resource (`bump`) has `previousVersion`, `newVersion`, `command`,
`exitCode`, and `success` fields. The `update` resource (`update`) has
`command`, `exitCode`, `success`, and `changedModules` — one entry per changed
module with `module`, `previousVersion`, and `newVersion`, sorted by module
path. The `dockerfile-sync` resource (`sync-dockerfile`) has `goVersion`,
`syncedTo`, `previousVersions`, `changed`, and `success` fields.
