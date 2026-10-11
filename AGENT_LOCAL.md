# Repository context: uci-arena-evidence-service

Universal engineering and design guidance comes from the account-global `AGENTS.md`.

## Mission and ownership

UCI Arena Evidence Service is the standalone evidence-orchestration product. It owns scheduling, admission, resource isolation, qualification workflows, timing-profile generation, normalization, resumability, result catalogs, datasets/publication, daemon lifecycle, and service health/status.

## Local routing

Before substantive work run:

```text
node tools/spec-preflight.mjs --task "<description>" --changed-files <likely paths>
```

Read the active specs returned by preflight. Repository-boundary/runtime-contract/Manager/packaging/publication work also follows `specs/suite_lego_boundaries_v1.yaml` and the canonical suite architecture in `iteathen/uci-arena-installer`.

Timing-policy purpose and population/discovery/qualification boundaries follow
`specs/timing_evidence_purpose_v1.yaml`. Its production direction does not claim
all population-learning stages are implemented. Current optional engine-owned
runtime and clock admission remain in `specs/evidence_runtime_v2.md`.

## Local constraints

Engine-owned evidence runtime tools are invoked through published contracts. Chess legality, UCI engine behavior, referee behavior, engine-runtime statistical/timing algorithms, and private sibling source remain outside this service.
