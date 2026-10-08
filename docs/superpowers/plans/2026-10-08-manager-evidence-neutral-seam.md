# Minimal Manager / Evidence seam

Candidate under root review; Manager C++ remains read-only.

Authority: `engine_onboarding_v1.yaml` requires a differently identified
conforming engine to forward its exact registered options to Evidence without
core product branching. `external_service_adapters_v1.yaml` requires typed,
bounded provider-owned operations and receipt/inventory validation. Canonical
suite architecture keeps evidence-runtime behavior engine-owned.

Manager keeps the UI registration command's `engine_id` input. Its provider
projection resolves the existing registered engine and current verified receipt.
The optional manifest capability `evidence_runtime_contract_v2` and named
entrypoint `evidence_runtime_contract` name a versioned engine-owned contract
listed in the component inventory. Absence yields
typed `unsupported`; it does not invalidate generic UCI registration.

The projection forwards inline JSON bounded to 8192 UTF-8 bytes using
`api target register --target-json`. Its descriptor contains
exact registered executable, argument array, working directory, UCI options,
and component root / manifest locator / manifest SHA / runtime-contract locator.
The descriptor does not manufacture model/provider metadata or replace an
executable path with a profile file. Evidence persists this target-specific
binding separately from legacy columns and checks the exact inventory at
registration, admission and result harvesting.

Runtime v2 supplier identity matches the selected manifest rather than a fixed
product ID. Its runtime identity record is opaque to the service. A concrete
Vector runtime adapter may interpret its own identity behind this boundary.

Campaign projection advertises engine-owned named campaigns with inventoried,
bounded parameter schema files. Manager forwards only a selected advertised
name and schema-validated parameters, never arbitrary paths/raw launch config.
The historical target_id-only campaign command retains its v1 behavior.
Named campaigns use `api campaign enqueue --target <UUID> --campaign <name>
--configuration-json <JSON parameters>`; parameters are limited to 8192 bytes.

Registration returns the existing v1 envelope with payload status supported,
created, and target projection, or status unsupported / code
EVIDENCE_RUNTIME_UNSUPPORTED / created false. Supported projections expose id,
label, target_schema, actual engine_sha256, component_id/version,
runtime_identity_sha256, capabilities and campaigns with schemas. Manager's
UI request never supplies an executable or browser-owned path.

Minimal future Manager delta: replace legacy eligibility/model/numeric mapping
in `service.evidence_target_register` with the optional capability projection;
add advertised campaign-name / parameter-schema projection to existing
`service.evidence_campaign_enqueue` and UI controls. No engine runtime, model,
referee or statistics semantics move into Manager. JS candidate tests prove
two unrelated suppliers, engine substitution, immutable launch drift, optional
unsupported behavior, closed schemas, corruption, and preserved v1 behavior.
