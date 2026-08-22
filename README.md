# UCI Arena Evidence Service

The Evidence Service is the standalone timing-policy production service. Its product is a qualified, immutable timing-policy artifact derived from trustworthy population-scale completed-game evidence. It collects and preserves the evidence population, invokes declared analysis capabilities to derive candidates, qualifies frozen candidates on independent evidence, and publishes versioned policy artifacts.

Scheduling, resource admission, catalogs, reports, paired matches, SPRT support, timing profiles, and qualification jobs are production machinery serving that outcome. The existing deadline/provider qualifier and `uci_time_profile_v3` publication remain valuable stages, but they are not the complete purpose of the service.

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

## Timing-policy production

The product loop is:

```text
collect population evidence
          ↓
infer temporal value + minimum useful timing blocks
          ↓
compare candidate allocation strategies
          ↓
qualify on independent evidence
          ↓
publish immutable timing-policy artifact
          ↓
future games produce evidence for later policy generations
```

Timing evidence is population evidence, not a conclusion drawn from one game or one move. Individual games are retained observations. A timing curve, minimum useful timing block, local-pressure threshold, or allocation strategy gains authority only from sufficiently large, appropriately stratified populations whose target/runtime identity and experimental conditions are explicit.

The service is intended to learn three related things from those populations:

1. **Where does additional thinking time have downstream value?** Earlier decisions can constrain later reachable states and create causal dependency traps in which later moves are effectively forced. Extra late search cannot necessarily recover opportunity lost through an earlier weak decision. The temporal value shape must therefore be measured rather than hard-coded.
2. **What is the smallest additional time worth buying?** Search improvement is not assumed to be usefully proportional to every extra millisecond. Evidence should estimate minimum useful timing blocks: additional elapsed-search increments whose average benefit is large and reliable enough to justify their clock cost. Useful block sizes may increase as deeper search becomes more expensive.
3. **How should all timing pressures be combined?** Current game time remains authoritative over feasibility and opportunity cost. Candidate strategies may additionally consume bounded current-position evidence such as decision instability, several close credible candidates, or one stable decisive candidate. Those observations can pressure toward buying another useful block or toward earlier publication, but their thresholds and interactions are experimental questions rather than fixed multipliers chosen by architecture.

A large current candidate lead that is also volatile is deliberately not equivalent to a stable easy move. Evidence must preserve both pressures so candidate strategies can be compared honestly, including false-easy cases where early publication later proves costly.

This creates a deliberately one-way relationship with search. Search runs independently according to its own contract and should go as fast and effectively as it can. Timing does not control search depth, attention, topology, queues, or work allocation. A deployed Engine timing owner may make bounded read-only current-focus observations at allocation-reconsideration points for an already-qualified strategy, but that is **policy application**, not policy learning, and sends no control back into search. Population learning remains based on sealed completed-game evidence analyzed later.

Experiment-specific search metric semantics and statistical analysis remain behind declared runtime contracts. Evidence Service owns the population, exact experiment identity, durable production state, candidate lifecycle, qualification authority, provenance, and artifact publication. If a required analyzer does not yet exist, that is an external capability dependency rather than a reason to recreate search/statistical logic inside this repository.

Discovery and qualification remain separate production stages. Discovery determines what candidate policy should exist. Qualification determines whether a frozen candidate may become a qualified published artifact. Existing provider/deadline timing qualification remains important, but it does not by itself establish a population timing law, useful timing blocks, local-pressure thresholds, or the best allocation strategy.

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
`40/120+5`. This first campaign is a bounded qualification/baseline campaign.
Its small candidate/control samples are useful for wiring, runtime, provider,
deadline, contamination, and basic comparative evidence, but are not a
population-scale timing-policy production campaign and cannot establish a
minimum useful timing step, local-pressure strategy, or qualified allocation
policy. Campaign evidence cannot displace the tracked `EarlyCurrent` live
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
