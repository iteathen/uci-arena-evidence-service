# UCI Arena Evidence Service

The Evidence Service is a standalone Node.js orchestrator for the existing UCI
Arena timing, match, SPRT, and complete-game tools. It owns durable scheduling,
resource admission, evidence normalization, and qualified timing-profile
publication. Chess legality and terminal state remain in the existing C++
referee; the existing Node match runner owns UCI orchestration and statistics.

Node.js 24.15 or newer and the repository's C++ engine/referee binaries are
required. The daemon, catalog, scheduler, resource governor, startup
integration, normalization pipeline, qualifier, and clocked match controller
are Node.js. No Python process or adapter is used. The service has no npm
dependencies.

## Initialize and inspect

Windows defaults to `E:\uci-arena-evidence`. Linux defaults to
`${XDG_STATE_HOME:-$HOME/.local/state}/uci-arena-evidence`. Override either with
`UCI_ARENA_EVIDENCE_ROOT` or `--workspace`.

```powershell
node tools/arena_evidence_service/src/cli.mjs init
node tools/arena_evidence_service/src/cli.mjs status --json
node tools/arena_evidence_service/src/cli.mjs daemon --once
```

If `runtime_state/active_model_runtime.json` does not expose an exact model
identity, add an explicit target:

```powershell
node tools/arena_evidence_service/src/cli.mjs target add `
  --model-id resnet_fp16 `
  --model-root engine/runtime/models/resnet_fp16/engine `
  --fingerprint 123456789 `
  --engine build/Release/flashfork_uci.exe `
  --provider directml
```

The equivalent Linux command uses the configured Linux engine and model paths.
No filename is accepted as a substitute for the declared model fingerprint.

Enqueue the registered first campaign:

```powershell
node tools/arena_evidence_service/src/cli.mjs job enqueue --campaign first --target TARGET_UUID
```

It runs deadline/provider qualification, the `30+0`, `60+2`, `180+0`, and
`180+3` time-use curve, paired `RelativeClockV3` versus current-policy games,
fixed-identity Stockfish depth 8/10/12/14 anchors, and finally `40/120+5`.

## Background resource behavior

The daemon runs one engine shard at a time. It waits for sustained host and GPU
idle evidence, available memory and disk, AC power, no Restaurant owner, and no
foreground Arena request. It shares one fair heavy-background lease with Book
Forge. Book Forge's lightweight acquisition and integration publication remain
independent.

Direct Arena runners request foreground priority. A background child is
terminated within two seconds and requeued when foreground work appears.
Windows uses Job Object cleanup when the Book Forge native helper is available;
Linux uses a separate process group, and the systemd unit uses
`KillMode=control-group`. Target threads, provider, batch configuration, and
search options are never silently throttled.

Missing or contaminated GPU isolation authority produces diagnostic data only.
Only an exact-identity `uci_time_profile_v3` candidate with passing qualifier
and resource gates can be atomically published. The service never changes a UCI
default or enables adaptive play.

## Startup

Windows registers a per-user Task Scheduler logon task through the existing
generic windowless launcher:

```powershell
node tools/arena_evidence_service/src/cli.mjs startup install
node tools/arena_evidence_service/src/cli.mjs startup status
node tools/arena_evidence_service/src/cli.mjs startup uninstall
```

Linux installs a `systemd --user` unit with low CPU/I/O weight:

```bash
node tools/arena_evidence_service/src/cli.mjs startup install
systemctl --user status uci-arena-evidence.service
node tools/arena_evidence_service/src/cli.mjs startup uninstall
```

The Linux user manager must be available. Enable login lingering separately
only if the service must run while the user is logged out.

## Data and controls

Raw artifacts are immutable and content-addressed. A single-writer SQLite
catalog indexes normalized `uci_arena_observation_envelope_v1` records and
identity-scoped datasets. Collection pauses below 75 GiB free space and never
silently deletes evidence.

```powershell
node tools/arena_evidence_service/src/cli.mjs pause --reason maintenance
node tools/arena_evidence_service/src/cli.mjs resume
node tools/arena_evidence_service/src/cli.mjs job list
node tools/arena_evidence_service/src/cli.mjs dataset list
node tools/arena_evidence_service/src/cli.mjs dataset export --id DATASET_UUID --out evidence.jsonl
node tools/arena_evidence_service/src/cli.mjs prune --before 2026-01-01T00:00:00Z
node tools/arena_evidence_service/src/cli.mjs prune --before 2026-01-01T00:00:00Z --confirm PRUNE
```

The first prune command is a recorded dry run. Only the exact `PRUNE`
confirmation performs deletion.
