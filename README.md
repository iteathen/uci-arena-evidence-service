# UCI Arena Evidence Service

The Evidence Service is a standalone Node.js orchestrator for the existing UCI
Arena timing, match, SPRT, and complete-game tools. It owns durable scheduling,
resource admission, evidence normalization, and qualified timing-profile
publication. Chess legality and terminal state remain in the existing C++
referee; the existing Node match runner owns UCI orchestration and statistics.

Node.js 24.15 or newer and the separately installed
`uci_arena_evidence.runtime` component are required for queued jobs. The
daemon, catalog, scheduler, resource governor, startup
integration, normalization pipeline, qualifier, and clocked match controller
are Node.js. No Python process or adapter is used. Its only local Node
dependencies are the product-neutral background-service runtime and
time-profile contract packages, both pinned by the service lockfile.

Set `UCI_ARENA_EVIDENCE_RUNTIME_ROOT` to the installed runtime-component root
when the Manager has not injected that location. Before it constructs any
queued adapter command, the service validates
`contracts/evidence-runtime-contract.json`, the component identity and target,
and all three allowlisted Node entrypoints. Missing runtime files are healthy
while the queue is idle, but fail the affected job before a subprocess starts.

## Initialize and inspect

Windows defaults to `E:\uci-arena-evidence`. Linux defaults to
`${XDG_STATE_HOME:-$HOME/.local/state}/uci-arena-evidence`. Override either with
`UCI_ARENA_EVIDENCE_ROOT` or `--workspace`.

```powershell
node src/cli.mjs init
node src/cli.mjs status --json
node src/cli.mjs daemon --once
```

If `runtime_state/active_model_runtime.json` does not expose an exact model
identity, add an explicit target:

```powershell
node src/cli.mjs target add `
  --model-id resnet_fp16 `
  --model-root engine/runtime/models/resnet_fp16/engine `
  --fingerprint 123456789 `
  --engine build/Release/uci_arena_engine.exe `
  --provider directml
```

The equivalent Linux command uses the configured Linux engine and model paths.
No filename is accepted as a substitute for the declared model fingerprint.

Enqueue the registered first campaign:

```powershell
node src/cli.mjs job enqueue --campaign first --target TARGET_UUID
```

It runs deadline/provider qualification, the `30+0`, `60+2`, `180+0`, and
`180+3` time-use curve, paired offline `AdaptiveCurveV1` versus `EarlyCurrent`
games, fixed-identity Stockfish depth 8/10/12/14 anchors, and finally
`40/120+5`. Campaign evidence cannot displace the tracked `EarlyCurrent` live
authority by itself.

UCI Arena Manager uses the component-declared API for the same bounded workflow.
Its Services page can turn an already registered, receipt-verified UCI Arena
Engine into an exact Evidence target without asking the operator for paths or
JSON. Manager repeats the universal UCI probe and passes only typed identity
fields; Evidence validates both paths, hashes the engine, and idempotently owns
target creation. Manager can then inspect redacted target/job summaries, enqueue
only the built-in first campaign, and cancel or retry service-issued job IDs.
The API cannot submit arbitrary adapters, flags, browser-selected paths, or
commands and never opens the service catalog directly.

## Background resource behavior

The daemon runs one engine shard at a time. It waits for sustained host and GPU
idle evidence, available memory and disk, AC power, no Restaurant owner, and no
foreground Arena request. It shares one fair heavy-background lease with Book
Forge. Book Forge's lightweight acquisition and integration publication remain
independent.

Direct Arena runners request foreground priority. A background child is
terminated within two seconds and requeued when foreground work appears.
Windows uses Job Object cleanup when the UCI Arena background-service helper is available;
Linux uses a separate process group, and the systemd unit uses
`KillMode=control-group`. Target threads, provider, batch configuration, and
search options are never silently throttled.

Missing or contaminated GPU isolation authority produces diagnostic data only.
Only an exact-identity `uci_time_profile_v3` candidate with passing qualifier
and resource gates can be atomically published. The service never changes a UCI
default or enables adaptive play.

The public profile projection exposes validated live profiles and any explicitly
configured in-place imports without reading raw evidence or scanning disks:

```powershell
node src/cli.mjs profile list --json
```

`profileImports` in `uci_arena_evidence_service_config_v1` is an array of
explicit profile-file paths. Imported profiles remain externally owned and are
never copied, rewritten, or treated as newly qualified for a different runtime.

## Startup

Windows registers a per-user Task Scheduler logon task through the existing
generic windowless launcher:

```powershell
node src/cli.mjs startup install
node src/cli.mjs startup status
node src/cli.mjs startup uninstall
```

Install first drains any prior registration and exact lock-owning daemon, then
reports success only after the task matches the current package and
configuration and the replacement daemon is active. Status reports registration,
configuration agreement, and activity independently. Uninstall waits up to two
seconds for the exact lock-owning daemon to exit and removes only its dead lock;
this prevents repair or upgrade from racing a replacement daemon.

Linux installs a `systemd --user` unit with low CPU/I/O weight:

```bash
node src/cli.mjs startup install
systemctl --user status uci-arena-evidence.service
node src/cli.mjs startup uninstall
```

The Linux user manager must be available. Enable login lingering separately
only if the service must run while the user is logged out.

## Data and controls

Raw artifacts are immutable and content-addressed. A single-writer SQLite
catalog indexes normalized `uci_arena_observation_envelope_v1` records and
identity-scoped datasets. Collection pauses below 75 GiB free space and never
silently deletes evidence.

```powershell
node src/cli.mjs pause --reason maintenance
node src/cli.mjs resume
node src/cli.mjs job list
node src/cli.mjs dataset list
node src/cli.mjs profile list --json
node src/cli.mjs dataset export --id DATASET_UUID --out evidence.jsonl
node src/cli.mjs prune --before 2026-01-01T00:00:00Z
node src/cli.mjs prune --before 2026-01-01T00:00:00Z --confirm PRUNE
```

The first prune command is a recorded dry run. Only the exact `PRUNE`
confirmation performs deletion.

## Package boundary and persistent data

The repository root is the Evidence Service package root. It imports no Book
Forge, Arena runner, engine-tool, or Manager source. Evaluation programs are
invoked through the allowlisted `uci_arena_evidence.runtime` component, while
shared validation and host controls are regular-file package inputs pinned by
`vendor/upstream.lock.json`.

`contracts/service-contract.json` is the installed public boundary. It binds
the component version, CLI, configuration and status schemas, capabilities,
startup ownership, status health smoke, data paths, and persistence policy.
UCI Arena Manager verifies it against the signed component manifest and keeps
its digest in the install receipt.

The workspace is deliberately separate from installed binaries. It contains
the SQLite catalog, immutable content-addressed artifacts, attempts, exports,
qualified profile candidates, and locks/heartbeat state. Repair, upgrade,
startup removal, and default uninstall preserve this workspace. Audited prune
is the only ordinary service operation that removes retained evidence; an
explicit installer data-removal choice is required to remove the complete
workspace.
