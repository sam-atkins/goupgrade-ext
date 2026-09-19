# @dismal_swamper/goupgrade

Upgrades Go projects: bumps the Go toolchain version in `go.mod` via
`go get go@<version>` and updates all module dependencies via
`go get -u all`. Each method records what changed — the previous and new Go
versions, or the full per-module require diff — before reporting success or
failure.

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

On any failure, a failure record is written to the corresponding resource
before the method throws, so the exact command, exit code, and stderr are
captured in the data model.

## Output

The `result` resource (`bump`) has `previousVersion`, `newVersion`, `command`,
`exitCode`, and `success` fields. The `update` resource (`update`) has
`command`, `exitCode`, `success`, and `changedModules` — one entry per changed
module with `module`, `previousVersion`, and `newVersion`, sorted by module
path.
