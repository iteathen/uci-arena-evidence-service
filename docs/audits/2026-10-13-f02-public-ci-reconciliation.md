# F02 follow-up: Evidence Service public source and CI authority

Scope: reconcile the Evidence Service-owned repository boundary at base `9cec903b4c17fd4ff41ea07ed20302f06d062f01`, following [Installer PR #219](https://github.com/iteathen/uci-arena-installer/pull/219), merge `254208833c3c903dd5fe57674c5cc297582207e8`, and the separately completed [Book Forge PR #46](https://github.com/iteathen/uci-arena-book-forge/pull/46), merge `cdd58c65f11d5ee2d61f1528748738632cc98f1e`. This specification correction grants no release authorization or asset-content security approval.

Cause: the active boundary still declared private visibility and disabled hosted CI after the public-source/read-only-CI transition. Existing automation checks already allow read-only CI and require separate manual release dispatch, leaving the active specification inconsistent with current owner-controlled implementation and metadata.

## Reasoning and admissible solutions

Objectives: G-O1 trustworthy chess feedback and G-O2 understandable operation; E-O1 reliable evidence and E-O3 manageable evidence production. Relevant premises: G-P4/G-P6/G-P9/G-P23/G-P28 and E-P6/E-P10/E-P14. Assertions: G-A3/G-A7/G-A26 and E-A11/E-A14. Targets: G-T4/G-T6/G-T9/G-T12/G-T14 and E-T6/E-T7/E-T9/E-T11. G-D3 preserves operator/credential authority, G-D4 rejects divergent cross-component truth, and G-D8/E-D3 prohibit upgrading unqualified or failed evidence for convenience. E-D1 preserves independent final validation when policy publication is concerned. Public source and useful CI create no unavoidable conflict with those boundaries.

| Candidate | Benefit and cost | Disposition |
| --- | --- | --- |
| A: reconcile this owner's active specification and distinguish public candidate transport from authorization/evidence qualification | Truthful current posture without a new runtime or trust mechanism | Selected |
| B: retain public source/CI but establish separately approved private candidate transport | Can satisfy a demonstrated embargo; adds access/transport ownership and operational cost | Reserve for separately established confidentiality need |
| C: privatize the source and disable CI | Restores old wording but contradicts current owner direction and cannot undo prior exposure | Rejected |
| D: remove publication/provenance/qualification gates because bytes are public | Reduces ceremony by manufacturing authority from accessibility | Rejected: violates security and evidence hard gates |

Implementation: only `specs/repository_boundary_v1.yaml` and this record. Preserve local qualification before opening PRs and merging, plus required hosted CI. Keep runtime ownership, exact identity/resource interval, declared qualification support, SBOM/test receipts, keyless signature/DSSE verification, component publication and Installer-only suite promotion unchanged. Historical private/no-CI declarations remain auditable in the [base specification](https://github.com/iteathen/uci-arena-evidence-service/blob/9cec903b4c17fd4ff41ea07ed20302f06d062f01/specs/repository_boundary_v1.yaml); historical results are not rewritten.

## Evidence and qualification boundary

Observed 2026-10-13 through GitHub API: repository is public and existing component prereleases are non-draft with three assets. [Base CI](https://github.com/iteathen/uci-arena-evidence-service/blob/9cec903b4c17fd4ff41ea07ed20302f06d062f01/.github/workflows/ci.yml) runs read-only PR/declared branch-push validation, without persisted checkout credentials or release jobs. [Base release workflow](https://github.com/iteathen/uci-arena-evidence-service/blob/9cec903b4c17fd4ff41ea07ed20302f06d062f01/.github/workflows/component-release.yml) runs only by manual dispatch, builds exactly three candidate assets, signs and verifies exact keyless provenance plus independent DSSE payload, then creates its own non-draft prerelease at the dispatched source head. Unlike Book Forge it does not use a pre-provisioned empty candidate or that workflow's remote three-asset digest-verification loop. This packet does not redesign either producer's release path.

Validation: required specification preflight; vendor-lock, repository-boundary and automation checks; lockfile npm audit; YAML parsing and unchanged contracts/rules/validation/manual-release comparison. Fresh non-author review and exact PR-head CI qualify integration and are recorded on the PR. Evidence is project-controlled internal qualification. No runtime code, dependencies, workflows, permissions, signing operations, assets, repository settings, or credentials changed. Windows native execution, real timing/strength/engine claims, full historical asset/secret/license exposure review and stable suite readiness remain unqualified.

Next bounded security task: separately review Syzygy's public-repository/private-intake conflict with the owner and an independent security reviewer. Its private guard and draft candidates remain intact; this packet supplies no authority to remove the guard, sign/dispatch, publish drafts, or claim current receipt closure. Historical published asset-content review remains a separate scoped task.
