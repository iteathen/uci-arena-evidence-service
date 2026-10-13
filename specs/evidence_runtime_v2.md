# Engine-owned JavaScript evidence runtime v2

Status: authorized implementation candidate, updated 2026-10-11. Service 0.3.19
adds campaign clock/profile path restoration; all historical releases and
provenance remain immutable.

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

Service 0.3.19 consumes optional top-level `clock_option_bindings` using the
closed `arena_uci_clock_option_bindings_v1`/version 1 profile declaration. One or
two bounded UCI names map only to `initial_ms` or `increment_ms`. A supplied
declaration must exactly match the selected inventoried launch profile, and
bound target options must keep that profile's bounded UCI scalar baseline. The
comparison uses exact UCI string representation after scalar/type/size/control
validation: numeric `0` and string `"0"` are equivalent, while `"00"` is not a
substitute for numeric `0`. Original target representations remain unchanged;
baseline placeholders grant no original clock authority. If omitted by
an older registration client, admission can derive it from that same public
profile. It participates in target deduplication and identity; a previously
cached target without the declaration cannot silently match a newly declared
target. Malformed retained declarations are catalog corruption; execution
revalidates exact declaration/profile identity.

The campaign must explicitly supply schema-admitted `initialTimeMs` and/or
`incrementMs` for the fields its declaration uses. No default, local Manager
probe, remaining clock or policy evidence supplies those original facts.
Before enqueue and execution, the host validates the original parameters and
the mapped parameters against the runtime's existing public schema. Execution
maps them into ephemeral `candidateOptions` and `controlOptions`; registered
launch options and stored original campaign parameters remain unchanged. A
conflicting per-role UCI representation or a runtime that does not admit those role fields
fails before attempt files or engine launch. These request options enter the
engine-owned runner before readiness. The declaration remains identity metadata
in the opaque target identity echo, not an added UCI launch argument or a new
runtime executor interface.

The existing v2 runner exposes no independent typed UCI spin/bounds observation
port. Evidence does not add a UCI controller or claim such qualification. It
validates the published declaration, safe UCI baseline, explicit original input
and public campaign bounds; engine-owned readiness remains the actual option
acceptance gate, and readiness failures remain failures. The unchanged Vector
runner sends options before `ucinewgame`/`isready`; Vector's `ucinewgame` clears
game state and policy admission but preserves configured options. Other timing
qualification, strategy and publication authority remains engine-owned.

An explicit `TimingPolicyFile`/`TimingPolicySha256` pair is projected through the
exact selected inventory to an absolute contained regular path with matching
SHA256. Partial pairs, links, escapes, unlisted files and digest substitution
fail. No file extension or arbitrary option string is interpreted as a path.
The Installer renderer emits this normalized target and keeps its clock baseline.

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

Installer retains context/binding v1. The current concrete cuda-js suite cohort
binds Node + Vector through evidence_runtime_root, engine_component_manifest and
engine_launch_profile metadata. Inventoried managed profile launch/options become
a typed active target without reconstructing model identity. This selected
cohort does not restrict generic service targets. Signed Windows publication
and reproducibility remain provider-workflow authority; packaging fixtures do
not substitute for that evidence.

Service 0.3.20 additionally admits optional `engine_configuration` through the
Installer's generic fresh dependency-configuration source. Its object must
match the same inventoried portable launch's component/root, adapter,
executable, arguments, working directory, conservative enabled state, null
expected runtime and clock declaration. Inventoried component-file arguments
may resolve to absolute paths; other argument values remain exact. Pinned
RequireTimingPolicy/file/digest presence and values retain immutable authority.
The existing runtime target validator still owns scalar bounds, clock baseline
and exact inventory. Producer-generated Book options are forwarded opaquely;
the service does not reconstruct snapshot authority or infer strength from them.
Present invalid fresh input fails composition; missing fresh input retains
the inventoried factory-profile compatibility route. This source amendment
does not claim protected release qualification or installed acceptance.

The renderer also preserves only explicitly persisted resource options from a
bounded regular existing provider configuration, validated through the same
provider configuration resolver used by runtime loading. Defaults remain
unchanged. Linked ancestors, file substitution, changed/oversized input and
invalid UTF-8/JSON/configuration fail before composition. Engine/target/native
helper/runtime/attestation bindings are regenerated; existing configuration
does not become new release or evidence authority. This lets a valid operator
disk floor remain effective through update and public Installer verification.
