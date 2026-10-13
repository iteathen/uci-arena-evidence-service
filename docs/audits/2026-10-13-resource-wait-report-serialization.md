# Preserve ordinary resource waits through the strict catalog boundary

The installed 0.3.21 provider's first bounded native campaign reached an ordinary resource wait, then its daemon failed with `EVIDENCE_CATALOG_JSON_INVALID`. No measurements or qualification were produced. The failed run and its queued/waiting jobs remain intact; the operator paused the campaign.

Cause: ResourceGovernor admission snapshots have no GPU-isolation report schema. `compactReport` unconditionally copied `resource.schema`, creating an undefined object value rejected by the existing bounded plain-JSON catalog validator. Waiting correctly prevented execution, but serializing that valid wait incorrectly stopped the daemon.

This affects E-O3 resumability and inspection, with E-P6 retaining failed/negative results and the suite's evidence and bounded-port concerns. Resource permission still dominates execution: an ordinary permit does not establish isolation, timing, strength or tuning authority. Fixing persistence cannot turn a wait into an admissible run.

Candidates considered: (A) represent an undeclared report schema as null in the existing compact projection; (B) omit that property for ordinary permits; (C) introduce a new ResourceGovernor snapshot schema; (D) weaken catalog validation to accept undefined values. A preserves the existing summary shape, explicitly represents unknown schema, and leaves actual declared isolation schemas untouched. B is admissible but needlessly changes summary shape; C requires a larger contract change for a reporting defect; D was rejected because it weakens the catalog boundary and silently loses incompatible values during JSON serialization.

Selected implementation changes one expression to `resource.schema ?? null`. No catalog validator, resource/GPU/lease admission, runtime, clock mapping, credential, provenance, workflow permission, dataset qualification or publication rule changes. Version 0.3.22 is a fresh immutable candidate identity; historical candidates remain unchanged.

A real Catalog/runDaemon one-cycle regression with a schema-less denied permit reproduced the identical serialization error before the fix, then passed. It proves the wait persists, no lease/guard/subprocess/attempt starts, the dataset remains unchanged, all compact authority flags remain false, and normal daemon-lock release occurs. Full validation, independent review, exact-head CI, protected publication and installed replay are separate remaining gates. The 60-second native request budget triggers cancellation; joined cleanup can extend completion time.
