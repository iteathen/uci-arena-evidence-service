#!/usr/bin/env node

const changedIndex = process.argv.indexOf("--changed-files");
const changed = changedIndex < 0 ? [] : process.argv.slice(changedIndex + 1);
const specs = new Set([
  "specs/00_READ_FIRST.yaml",
  "specs/repository_boundary_v1.yaml",
  "specs/timing_evidence_purpose_v1.yaml",
]);
if (changed.length === 0 || changed.some((name) =>
  /^(src|test|fixtures|contracts|release|tools|package)/u.test(name))) {
  specs.add("specs/uci_arena_evidence_service_v1.yaml");
}
process.stdout.write(`${JSON.stringify({
  schema: "evidence_service_spec_preflight_v1",
  required_specs: [...specs],
}, null, 2)}\n`);
