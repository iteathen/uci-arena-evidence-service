# UCI Arena Evidence Service

The Evidence Service is a standalone Node.js orchestrator for the existing UCI
Arena timing, match, SPRT, and complete-game tools. It owns durable scheduling,
resource admission, evidence normalization, and qualified timing-profile
publication. Chess legality and terminal state remain in the existing C++
referee; the existing Node match runner owns UCI orchestration and statistics.

The production direction is qualified, immutable timing-policy artifacts from
identity-bound completed-game populations. Discovery, frozen candidate
comparison and independent held-out qualification must remain distinct. Current
scheduling and qualification machinery is a subset of that direction; this does
not claim the full population-learning pipeline exists. See
[timing-policy purpose](specs/timing_evidence_purpose_v1.yaml), which reconciles
the unique governance work in historical [PR47](https://github.com/iteathen/uci-arena-evidence-service/pull/47).

Node.js 24.15 or newer and the separately installed
`uci_arena_evidence.runtime` component are required for legacy v1 queued jobs.
An explicitly selected engine-owned [runtime-v2 capability](specs/evidence_runtime_v2.md)
uses its own receipt/inventory-bound target instead. Current Vector is the
independent JavaScript/Device-JS engine product; cancelled C++ chess/search is
not a fallback. Independently published native referee and process helpers
retain their generic roles. The
daemon, catalog, scheduler, resource governor, startup
integration, normalization pipeline, qualifier, and clocked match controller
are Node.js. No Python process or adapter is used. Its only local Node
dependencies are the product-neutral background-service runtime and
time-profile contract packages, both pinned by the service lockfile.

For legacy v1, set `UCI_ARENA_EVIDENCE_RUNTIME_ROOT` to the installed runtime-component root
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

For a workspace copied after uninstall, pause the source first, uninstall its
startup registration, and retain the source originals while copying the closed
catalog plus `artifacts` and `attempts` data. Run this before installing fresh
startup registration:

```powershell
node src/cli.mjs workspace adopt-locators --source-workspace C:/old-evidence --workspace E:/new-evidence
```

Both startup registrations must be absent and the copied catalog must already
be paused. The command verifies daemon absence, original and copied file
identities, artifact digests and log bytes before updating only the three
artifact/log locator columns. Historical provenance remains unchanged. It needs
no engine or selected evidence runtime; Windows needs the packaged identity
helper and its local Task Scheduler COM query. Access-denied or unavailable
startup observations defer; a numeric task-command exit code cannot prove
absence. Exit codes are 0 for confirmed adoption, 2 for deferred verification,
and 1 for an uncertain effect or cleanup failure. The optional
`--maximum-milliseconds` accepts 1..60000 and bounds cooperative work.
Recognized legacy owner records require a positive native PID-absence query;
PID reuse can be admitted only when the original exact identity was retained.
No identity or process-exit evidence is inferred from stale timestamps.

If an earlier relocation retained absolute artifact/log locators beneath a
retired workspace, explicitly declare that locator namespace with the repeatable
`--historical-locator-root ABSOLUTE_PATH` option (at most eight). Each declared
root must be absent at its exact leaf beneath existing ordinary parents; present,
inaccessible or reparse paths defer. No historical root is inferred and no
unavailable historical daemon record is treated as verified. Its artifact/log
relative names resolve through the current retained source workspace for original
file verification, then the copied destination. Artifact catalog hashes/lengths,
original/copy log bytes, unambiguous projections and the existing canonical
source/destination startup and daemon guards remain mandatory. Other catalog
columns and opaque historical provenance remain unchanged. This is an explicit
repair of retired locator namespaces, not support for additional live workspaces.

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

Timing jobs use the runtime qualifier's candidate and identity-bound checkpoint
contract. Candidates never write the live cache directly. Their sibling attempt
records are retained as content-addressed diagnostic observations, including on
producer failure, while only the final profile can gain timing or publication
authority. Older valid v3 profiles that predate the additive permission
projection remain discoverable by deriving provider and forecast status from
the complete current gate set; explicit false permissions are never upgraded.

The public profile projection exposes validated live profiles and any explicitly
configured in-place imports without reading raw evidence or scanning disks:

```powershell
node src/cli.mjs profile list --json
```

`profileImports` in `uci_arena_evidence_service_config_v1` is an array of
explicit profile-file paths. Imported profiles remain externally owned and are
never copied, rewritten, or treated as newly qualified for a different runtime.

## Startup

The prepared 0.3.20 source is an incomplete repair candidate. Its ordinary
Windows uninstall path consumes the new exact-incarnation stop capability,
but its manifest still declares startup-control v1. Installer upgrades from
0.3.19 therefore still select that old installed controller. The staged v3
replacement bridge and its qualification are pending; this candidate must not
be published or used to claim that the upgrade defect is repaired.

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
configuration agreement, and activity independently. Windows uninstall uses the
qualified public native helper to stop the exact lock-owning daemon incarnation;
Task Scheduler's launcher stop request alone is insufficient. Native stop and
independent exit/reuse proof share the unchanged two-second budget. PID reuse
never authorizes stopping the replacement process. Legacy PID-only records
receive no termination authority and require positive native absence.

Missing task registration is admitted through the closed typed startup-presence
observer. Access denial, unknown Task End/deletion failures, missing stop
capability, malformed identities, deferred stop and late exit evidence fail
closed and preserve recovery records. Registration is deleted only after daemon
exit proof; the retained lock is removed only if its complete contents still
match the retired owner. These service fixtures and owned-child native tests
provide internal qualification; installed Task Scheduler upgrade/uninstall
qualification belongs to the signed provider release and suite lifecycle run.

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

## Local validation

`npm run check` leaves the Engine-owned clocked-runner integration test skipped
when no Evidence Runtime component is available. To exercise an exact local
runtime without changing production configuration precedence, set only the
test input for that command:

```powershell
$env:UCI_ARENA_EVIDENCE_RUNTIME_TEST_ROOT = "C:\path\to\uci_arena_evidence.runtime"
npm run check
```

`UCI_ARENA_EVIDENCE_RUNTIME_ROOT` remains the production invocation override
and is intentionally not used as a test-fixture selector.
