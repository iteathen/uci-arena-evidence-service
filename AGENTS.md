# UCI Arena Evidence Service Agent Contract

UCI Arena Evidence Service is the standalone evidence orchestration product. It owns scheduling, admission, resource isolation, qualification workflows, timing-profile generation, normalization, resumability, result catalogs, datasets/publication, daemon lifecycle, and service health/status. It invokes declared engine-owned evidence runtime tools through published contracts.

## Required start

1. Read `.agents/core-standard.md`.
2. Before substantive planning, inspection, implementation, or validation run:

```text
node tools/spec-preflight.mjs --task "<description>" --changed-files <likely paths>
```

3. Read every active specification returned by preflight and rerun when touched paths change materially.
4. For repository-boundary, runtime-contract, Manager integration, packaging, publication, or cross-project work, also read `specs/suite_lego_boundaries_v1.yaml` and the canonical suite architecture in `iteathen/uci-arena-installer`.

Do not preload old in-engine scheduling/service implementations, historical extraction plans, or unrelated suite specs.

## Ownership and reuse

Current Evidence Service specs/contracts own orchestration behavior; suite architecture owns cross-repository responsibility. Engine-owned evidence runtime executables provide allowlisted capabilities; they do not transfer chess/search/referee/timing truth into this service.

Before adding a new scheduler, queue/catalog, normalization path, dataset publisher, runtime invocation mechanism, resource-isolation mechanism, daemon control, or status store, search the current Evidence Service owners/specs first and reuse or extend the existing owner.

The service never owns chess legality, UCI engine behavior, referee behavior, SPRT/statistical engine-runtime math, or timing qualification algorithms that are declared engine runtime contracts. It never imports another repository's private source tree.

## Credentials, evidence, and recovery

Never read, print, summarize, hash, copy, validate, package, log, or commit credential contents. Handle only external references permitted by current contracts.

Evidence is trustworthy only when input/runtime identity, configuration, relevant provenance, result identity, and partial/blocked state remain explicit. Missing required runtime artifacts or evidence is blocked/failed, not silently skipped or inferred passing.

Long-running scheduling/publication workflows should be resumable and idempotent where practical, with bounded resource use and explicit recovery/retention behavior.

## Execution and debugging

For ambiguous scheduling, normalization, runtime invocation, result-catalog, resumability, or publication failures, preserve the original failure signature and trace raw expected-vs-actual evidence through the owning boundary before patching. A final score/report is not enough to clear a broken upstream evidence path.

## Validation and integration

Run the smallest complete preflight-selected local owner/contract validation first. Publication/provenance, persisted meaning, destructive retention, resource isolation, public compatibility, and recovery-sensitive changes retain stronger safeguards regardless of diff size.

Code changes are tested, committed and pushed on a branch, and opened as a draft PR. Before integration, inspect the complete diff, freeze the exact head, use guarded exact-head integration where supported, and verify the target result.

## Completion

Complete when the requested evidence-service outcome is evidenced, engine/runtime ownership remains external and explicit, evidence claims are reproducible at the required depth, and no material invalid partial workflow state remains.
