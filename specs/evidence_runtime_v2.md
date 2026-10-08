# Engine-owned JavaScript evidence runtime v2

Status: authorized implementation candidate, 2026-10-08. Service candidate
version 0.3.15; historical 0.3.14 release/provenance remains immutable.

The exact v1 validator, supplier, arguments, output validation and authority
remain source-compatible. V2 is an explicitly selected optional capability of
an engine component. The generic service never dispatches by product/model name,
provider name or identity schema. Public schemas are in
`contracts/evidence-runtime-v2.schema.json` and `evidence-target-v2.schema.json`.

The selected receipt's component manifest declares capability
`evidence_runtime_contract_v2` and named entrypoint `evidence_runtime_contract`.
The entrypoint references an inventoried v2 contract. The manifest is the sole
inventory owner: contract, runner, referee, opaque identity and parameter schema
files are contained regular files with exact SHA-256/length. Reparse/link
ancestors, streams, case aliases, traversal, substitution, drift and unknown
contract majors fail before subprocess creation.

The target descriptor binds exact registered executable, argv, working directory
and UCI options, plus selected component root/manifest/digest/entrypoint. The
executable remains an executable. V2 uses this target-specific binding;
`config.runtimeRoot` retains only historical v1 meaning. Runtime/model/library
identity is opaque and engine-owned; no numeric/digest coercion is permitted.

Catalog schema 3 adds one nullable bounded runtime_binding_json column. Version
1/2 migration preserves legacy rows/evidence. V2 launch columns are checked
projections with no invented model metadata. Corrupt binding JSON emits
EVIDENCE_CATALOG_CORRUPT and never falls back to global/legacy interpretation.
Bounded campaign/capability projections are stored as derived registered
snapshots tied to the admitted digest. UI status never rehashes model assets or
requires the optional engine to remain present. Execution and harvesting always
revalidate the authoritative manifest inventory; snapshots grant no live authority.

Manager keeps engine_id-only UI registration and resolves the optional capability
server-side. `api target register --target-json <inline JSON>` accepts 8192 UTF-8
bytes. Missing capability returns typed EVIDENCE_RUNTIME_UNSUPPORTED without
registering an Evidence target or invalidating generic UCI registration.

`api campaign enqueue --target <UUID> --campaign <advertised name>
--configuration-json <inline parameters>` accepts 8192 parameter bytes. Service
validates the inventoried closed structural schema before enqueue/execution.
Supported keywords: type, properties, required, additionalProperties,
maxProperties, items, minItems/maxItems, minLength/maxLength, minimum/maximum,
enum, const and inert schema/title metadata. Refs/regex/executable keywords are
unsupported. Depth/values/strings/arrays/numbers are bounded. Unknown fields and
campaigns fail closed. The target_id-only legacy default remains unchanged.

Available workloads accept --request and --output owned JSON paths. Requests
bind request/job/shard/workload, target identity, exact launch, component
binding/digests, campaign and validated parameters. Results use
uci_arena_evidence_result_v2, preserve complete/failed/incomplete states,
legal-game/clock measurements, identity and failures. Engine runtime owns UCI,
referee, chess, timing and statistics; service owns scheduling, isolation,
cancellation, retention, normalization and publication limits. V2 measurements
remain diagnostic-only until separate accepted qualification and exact evidence.

Installer retains context/binding v1. The current concrete CUDA.js suite cohort
binds Node + Vector through evidence_runtime_root, engine_component_manifest and
engine_launch_profile metadata. Inventoried managed profile launch/options become
a typed active target without reconstructing model identity. This selected
cohort does not restrict generic service targets. Signed Windows publication
and reproducibility remain provider-workflow authority; packaging fixtures do
not substitute for that evidence.
