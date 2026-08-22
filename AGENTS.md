# UCI Arena Evidence Service Agent Contract

UCI Arena Evidence Service is the standalone timing-policy production product. Its product output is a qualified, immutable timing-policy artifact derived from trustworthy population-scale completed-game evidence. It owns the production lifecycle around that output: experiment scheduling, admission and resource isolation, durable evidence identity and retention, population assembly, candidate lifecycle, qualification, publication, resumability, daemon lifecycle, and service health/status. It invokes declared evidence-runtime capabilities through published contracts. Scheduling, reports, timing profiles, and qualification jobs are machinery serving the product outcome; they are not the product purpose by themselves.

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

Current Evidence Service specs/contracts own the timing-policy production lifecycle; suite architecture owns cross-repository responsibility. External evidence-runtime executables provide allowlisted producer/analyzer capabilities; they do not transfer chess/search/referee/timing-analysis/statistical truth into this service.

The governing product loop is:

```text
collect population evidence -> derive candidate -> qualify -> publish immutable timing-policy artifact
```

Timing-policy discovery is population based: a single game, move, or position is never timing-law authority. Search/runtime observations may flow one way into retained evidence and be analyzed after completed games, but timing policy never controls search attention, depth, topology, queues, or other search internals. Runtime timing consumes a qualified policy only to determine downstream publication waiting/allocation.

Before adding a new scheduler, queue/catalog, normalization path, dataset publisher, runtime invocation mechanism, resource-isolation mechanism, daemon control, status store, population experiment owner, candidate owner, or policy-publication owner, search the current Evidence Service owners/specs first and reuse or extend the existing owner.

The service never owns chess legality, UCI engine behavior, referee behavior, search behavior, move selection, experiment-specific search metric semantics, or timing/statistical analysis algorithms that are declared external runtime contracts. It never imports another repository's private source tree.

## Credentials, evidence, and recovery

Never read, print, summarize, hash, copy, validate, package, log, or commit credential contents. Handle only external references permitted by current contracts.

Evidence is trustworthy only when input/runtime identity, configuration, relevant provenance, result identity, and partial/blocked state remain explicit. Missing required runtime artifacts or evidence is blocked/failed, not silently skipped or inferred passing.

Long-running collection/qualification/publication workflows should be resumable and idempotent where practical, with bounded resource use and explicit recovery/retention behavior. Population-scale timing campaigns must remain bounded per scheduling operation even when the complete evidence population spans many games and long collection windows.

## Execution and debugging

For ambiguous collection, scheduling, normalization, runtime invocation, result-catalog, candidate, qualification, resumability, or publication failures, preserve the original failure signature and trace raw expected-vs-actual evidence through the owning boundary before patching. A final score/report is not enough to clear a broken upstream evidence path.

## Validation and integration

Run the smallest complete preflight-selected local owner/contract validation first. Publication/provenance, persisted meaning, destructive retention, resource isolation, public compatibility, population-authority classification, and recovery-sensitive changes retain stronger safeguards regardless of diff size.

Code changes are tested, committed and pushed on a branch, and opened as a draft PR. Before integration, inspect the complete diff, freeze the exact head, use guarded exact-head integration where supported, and verify the target result.

## Completion

Complete when the requested timing-policy production outcome is evidenced, external runtime ownership remains explicit, evidence claims are reproducible at the required depth and population scale, discovery and qualification authority are not conflated, the resulting artifact authority is explicit, and no material invalid partial workflow state remains.
