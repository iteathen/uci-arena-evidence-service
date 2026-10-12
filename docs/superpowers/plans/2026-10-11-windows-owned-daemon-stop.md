# Windows owned daemon stop implementation plan

> **For agentic workers:** Use inline execution for the Evidence consumer and an independently reviewed producer change for the generic SDK. Do not merge, sign, install, or exercise installed services in this work packet.

**Goal:** Make Windows startup uninstall actively stop the exact recorded daemon incarnation before permitting replacement or reporting removal.

**Disposition at owner pause:** WIP, not release-ready. The ordinary Windows uninstall fix is implemented and internally qualified. The existing 0.3.19 controller would still run during an Installer upgrade because this component continues to declare startup-control v1. A staged replacement lifecycle bridge is required before 0.3.20 can repair that upgrade path. Its first RED test is committed; no bridge implementation or publication is complete. Version metadata is prepared only.

**Architecture:** Task Scheduler owns the launcher registration; Evidence owns the daemon record and teardown transaction; the public background runtime owns handle-bound native process termination. Task End remains a launcher-stop request and cannot establish daemon exit. Stop and independent exit observation share the existing shrinking two-second budget.

**Tech stack:** Node.js, published background-service-runtime package, existing generic native Windows helper.

**Spec:** `specs/uci_arena_evidence_service_v1.yaml` startup lifecycle verification and `specs/suite_lego_boundaries_v1.yaml`.

## Constraints and source cause

Evidence 0.3.19 at `6c87c81b28cb98b0a389f3411212a094a239eb9f` only issues `schtasks /End`, discards its errors, then passively waits for the daemon. A successful Task End with a still-live daemon reproduces the reported two-second failure. The actual installed Task End response was discarded and its cause remains unknown.

The selected SDK 1.2.0 snapshot at engine revision `a535772f818eba76473e4f931dcfc7b764f0c6c5` has no public incarnation-stop capability. Never substitute a PID-only kill, extend the deadline, deep-import sibling source, or patch vendored private code. The producer publishes and qualifies the new public stop operation first.

## One consumer work packet

- [x] Create the isolated Evidence worktree from the exact base; read accepted lifecycle and repository contracts.
- [x] Build the existing native helper and run baseline service/native/idle checks.
- [x] Freeze a RED regression with real record reading and mocked OS command/SDK boundaries; retain failed ownership records outside successful fixture cleanup.
- [x] Consume the reviewed immutable SDK snapshot and repin the complete vendor closure, package lock and vendor verifier identities: integrated engine main `ed21a5361b7dc80ac36fa27d66f9f81018b34305`, background runtime 1.4.0 and time-profile contract 1.5.0. Both full package snapshots match their source closure.
- [x] Qualify stop capability separately from read-only identity capability. Require the public full-identity stop operation only for Windows teardown, preserving pure description behavior.
- [x] Retain Task End as the launcher request; admit its failure only when the existing typed startup observer positively establishes absence. Present or unverifiable registration fails closed.
- [x] Request incarnation stop and independently prove its exit/reuse with one shrinking monotonic two-second budget. Legacy ownership never receives termination authority; positively absent legacy PIDs can retire.
- [x] Delete registration only after daemon exit proof; remove only the unchanged retained owner record. Changed ownership before deletion or during retirement fails instead of claiming an inactive workspace. Failed stop, query, registration observation or deletion preserves recovery records.
- [x] Cover native-owned daemon, PID/birth/executable mismatch, absent task, legacy, malformed/unverifiable/deferred results, late evidence, replacement record and resource cleanup.
- [ ] Implement the accepted staged startup-control v3 bridge with exact task before-image, provider-owned intent, rollback and repeated-request convergence. It must select its own staged declared native helper instead of a prior helper serialized in configuration. The first committed bridge regression is intentionally RED.
- [ ] Declare a closed provider-owned target mapping: Windows v3, unchanged Linux v1; reject unsupported targets or missing mapping. Update the component builder's currently v1-only validation and verify the actual staged manifest.
- [ ] Publish service metadata 0.3.20, reconcile startup docs/specs and run full service/native/idle checks without native skips.
- [ ] Hand the exact branch/head/tree/diff and evidence limits to the root for independent review. Root owns signing, installation and live lifecycle qualification.

## Evidence disposition

The RED fixture and raw log are retained in the task evidence directory. Repository tests and owned-child native execution establish internal qualification; they do not establish installed Task Scheduler behavior. The legacy runner integration needs its separately pinned runtime and may remain visibly skipped in this bounded no-engine-run packet. No GPU work belongs here.

An initial test interception was defective: Node's original `execFile` custom promisifier escaped the `t.mock.method` wrapper and executed real Task Scheduler commands. The root confirmed the installed old daemon stopped and its registration disappeared, then restored the prior service through the owner's public operation with its workspace still paused. The early `evidence-stop-red`, `evidence-stop-expanded-red`, `evidence-stop-native-red` and `evidence-stop-green` logs are archived incident evidence and excluded from qualification; they do not support a no-live-effects claim.

All current stop tests instead inject `executeImpl`, including the typed presence observer, and assert every command boundary. The admissible `evidence-stop-hermetic-red` log reproduces the original passive-wait failure by temporarily omitting active stop; the implementation was immediately restored. `evidence-stop-hermetic-green` passes 28/28, including a real test-owned native child. The subsequent `evidence-stop-interim-check` passes 185 service tests with one declared pinned-runner skip and no native skips; it includes the changed-owner rejection fix. Native CTest passes 2/2. These runs precede the newly committed intentionally RED bridge test, so the WIP branch's complete test suite is not green. Full release preflight, independent consumer review, signing and installed upgrade qualification remain pending.
