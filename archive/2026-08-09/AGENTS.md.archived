# AGENTS.md

The Evidence Service is a spec-driven standalone UCI Arena orchestrator.

The canonical complete-suite target is
[`UCI_ARENA_COMPLETE_LEGO_ARCHITECTURE.md`](https://github.com/iteathen/uci-arena-installer/blob/main/docs/architecture/UCI_ARENA_COMPLETE_LEGO_ARCHITECTURE.md).
Read `specs/suite_lego_boundaries_v1.yaml` before repository-boundary,
runtime-contract, Manager-integration, packaging, publication, or cross-project work.

Before substantive planning, inspection, implementation, or validation run:

```text
node tools/spec-preflight.mjs --task "<description>" --changed-files <paths>
```

Read every returned specification. Public behavior changes update the governing
specification first.

The service never owns chess legality, UCI orchestration, referee behavior,
SPRT math, or timing qualification. Those are allowlisted runtime contracts
provided by UCI Arena. The service never imports another repository.

Never read, print, hash, copy, validate, or package credential contents. Code
changes must be tested, committed, pushed, and opened as a draft pull request.
