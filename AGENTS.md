# UCI Arena Evidence Service Agent Contract

UCI Arena Evidence Service is the standalone timing-policy production product. Its product output is a qualified, immutable timing-policy artifact derived from trustworthy population-scale completed-game evidence. It owns the production lifecycle around that output: experiment scheduling, admission and resource isolation, durable evidence identity and retention, population assembly, candidate lifecycle, qualification, publication, resumability, daemon lifecycle, and service health/status. It invokes declared evidence-runtime capabilities through published contracts. Scheduling, reports, timing profiles, and qualification jobs are machinery serving the product outcome; they are not the product purpose by themselves.

## Required start

1. Read `.agents/core-standard.md`.
2. Before substantive planning, inspection, implementation, or validation run:

```text
node tools/spec-preflight.mjs --task "<description>" --changed-files <likely paths>
```

3. Read every active specification returned by preflight and rerun when touched paths change materially.
4. For timing evidence, campaign, dataset, timing-policy, profile, allocation-strategy, useful-block, or local decision-pressure analysis work, treat `specs/timing_evidence_purpose_v1.yaml` as mandatory purpose authority.
5. For repository-boundary, runtime-contract, Manager integration, packaging, publication, or cross-project work, also read `specs/suite_lego_boundaries_v1.yaml` and the canonical suite architecture in `iteathen/uci-arena-installer`.

Do not preload old in-engine scheduling/service implementations, historical extraction plans, or unrelated suite specs.

## Ownership and reuse

Current Evidence Service specs/contracts own the timing-policy production lifecycle; suite architecture owns cross-repository responsibility. External evidence-runtime executables provide allowlisted producer/analyzer capabilities; they do not transfer chess/search/referee/timing-analysis/statistical truth into this service.

The governing product loop is:

```text
collect population evidence
  -> infer temporal value + minimum useful timing blocks
  -> compare candidate allocation strategies
  -> freeze candidate
  -> qualify independently
  -> publish immutable timing-policy artifact
```

Timing-policy discovery is population based: a single game, move, or position is never timing-law, useful-block, local-pressure-threshold, or strategy authority.

Keep two one-way observation relationships distinct:

- **runtime policy application:** a downstream Engine timing owner may make bounded read-only current-focus observations such as decision instability, candidate ambiguity, or stable decisive-candidate separation when an already-qualified strategy declares those inputs. That is `search evidence -> move timing` only; timing never controls search attention, depth, topology, queues, or work.
- **population policy learning:** runtime/search/timing observations may be sealed after games and flow into Evidence Service for many-game analysis. New policy versions affect future games only after explicit qualification/publication and never mutate the active game's policy.

Do not confuse live bounded observation with live learning. Evidence Service does not poll an active search to make the current move-time decision and does not acquire current-game clock authority.

Before adding a new scheduler, queue/catalog, normalization path, dataset publisher, runtime invocation mechanism, resource-isolation mechanism, daemon control, status store, population experiment owner, candidate owner, or policy-publication owner, search the current Evidence Service owners/specs first and reuse or extend the existing owner.

The service never owns chess legality, UCI engine behavior, referee behavior, search behavior, live clock application, runtime move selection, runtime current-position observation implementation, experiment-specific search metric semantics, or timing/statistical analysis algorithms that are declared external runtime contracts. It never imports another repository's private source tree.

## Timing-pressure evidence rule

Whenever candidate timing strategies use multiple pressure inputs, collection and analysis must preserve all materially different pressure shapes until evidence justifies a reduction.

In particular:

- remaining clock, increment, hard reserves, minimum useful blocks, temporal value, decision instability, candidate ambiguity, and stable decisive-candidate evidence are not interchangeable because they all happen to influence time;
- a large current candidate separation that is also volatile must remain distinguishable from a large stable separation;
- do not hard-code universal centipawn gaps, complexity multipliers, easy-move percentages, or serial modifier formulas in this service;
- candidate strategies/thresholds are experimental treatments and gain authority only through population comparison plus independent qualification;
- preserve failed predictions and false-easy cases, not only successful clock savings.

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
