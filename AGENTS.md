# UCI Arena Evidence Service Agent Contract

UCI Arena Evidence Service is the standalone evidence orchestration product. It owns scheduling, admission, resource isolation, durable population evidence, discovery and qualification workflows, timing-policy candidate lifecycle, normalization, resumability, result catalogs, datasets/publication, daemon lifecycle, and service health/status. It invokes declared evidence-runtime tools through published contracts. Existing timing-profile qualification is a valid subset of this responsibility, not the complete purpose of the service.

## Required start

1. Read `.agents/core-standard.md`.
2. Before substantive planning, inspection, implementation, or validation run:

```text
node tools/spec-preflight.mjs --task "<description>" --changed-files <likely paths>
```

3. Read every active specification returned by preflight and rerun when touched paths change materially.
4. For timing evidence, campaign, dataset, timing-policy, profile, or analysis-contract work, treat `specs/timing_evidence_purpose_v1.yaml` as mandatory purpose authority.
5. For repository-boundary, runtime-contract, Manager integration, packaging, publication, or cross-project work, also read `specs/suite_lego_boundaries_v1.yaml` and the canonical suite architecture in `iteathen/uci-arena-installer`.

Do not preload old in-engine scheduling/service implementations, historical extraction plans, or unrelated suite specs.

## Ownership and reuse

Current Evidence Service specs/contracts own orchestration behavior; suite architecture owns cross-repository responsibility. External evidence-runtime executables provide allowlisted capabilities; they do not transfer chess/search/referee/timing-analysis/statistical truth into this service.

The service exists to produce trustworthy evidence at useful scale as well as to qualify and publish results. Timing-policy discovery is population based: a single game, move, or position is never timing-law authority. Search/runtime observations may be retained as one-way evidence and analyzed after completed games, but timing policy never controls search attention, depth, topology, queues, or other search internals. Timing controls only downstream publication waiting/allocation through a separately qualified policy artifact.

Before adding a new scheduler, queue/catalog, normalization path, dataset publisher, runtime invocation mechanism, resource-isolation mechanism, daemon control, status store, population experiment owner, or policy-publication owner, search the current Evidence Service owners/specs first and reuse or extend the existing owner.

The service never owns chess legality, UCI engine behavior, referee behavior, search behavior, experiment-specific search metric semantics, or timing/statistical analysis algorithms that are declared external runtime contracts. It never imports another repository's private source tree.

## Credentials, evidence, and recovery

Never read, print, summarize, hash, copy, validate, package, log, or commit credential contents. Handle only external references permitted by current contracts.

Evidence is trustworthy only when input/runtime identity, configuration, relevant provenance, result identity, and partial/blocked state remain explicit. Missing required runtime artifacts or evidence is blocked/failed, not silently skipped or inferred passing.

Long-running scheduling/publication workflows should be resumable and idempotent where practical, with bounded resource use and explicit recovery/retention behavior. Population-scale timing campaigns must remain bounded per scheduling operation even when the complete evidence population spans many games and long collection windows.

## Execution and debugging

For ambiguous scheduling, normalization, runtime invocation, result-catalog, resumability, or publication failures, preserve the original failure signature and trace raw expected-vs-actual evidence through the owning boundary before patching. A final score/report is not enough to clear a broken upstream evidence path.

## Validation and integration

Run the smallest complete preflight-selected local owner/contract validation first. Publication/provenance, persisted meaning, destructive retention, resource isolation, public compatibility, population-authority classification, and recovery-sensitive changes retain stronger safeguards regardless of diff size.

Code changes are tested, committed and pushed on a branch, and opened as a draft PR. Before integration, inspect the complete diff, freeze the exact head, use guarded exact-head integration where supported, and verify the target result.

## Completion

Complete when the requested evidence-service outcome is evidenced, external runtime ownership remains explicit, evidence claims are reproducible at the required depth and population scale, discovery and qualification authority are not conflated, and no material invalid partial workflow state remains.
