#!/usr/bin/env node

const changedIndex = process.argv.indexOf("--changed-files");
const changed = changedIndex < 0 ? [] : process.argv.slice(changedIndex + 1);
const specs = new Set([
  "specs/00_READ_FIRST.yaml",
  "specs/repository_boundary_v1.yaml",
]);
if (changed.length === 0 || changed.some((name) =>
  /^(src|test|fixtures|contracts|release|tools|package)/u.test(name))) {
  specs.add("specs/uci_arena_evidence_service_v1.yaml");
}
if (changed.length === 0 || changed.some((name) =>
  name === "src/cli.mjs"
  || name === "src/cli_contract.mjs"
  || name === "test/cli_contract.test.mjs"
  || name === "specs/cli_contract_v1.yaml"
  || name === "tools/spec-preflight.mjs")) {
  specs.add("specs/cli_contract_v1.yaml");
}
if (changed.length === 0 || changed.some((name) =>
  name === "src/cli.mjs"
  || name === "src/dataset_read_store.mjs"
  || name === "src/dataset_export.mjs"
  || name === "test/dataset_export.test.mjs"
  || name === "specs/dataset_export_contract_v1.yaml"
  || name === "tools/spec-preflight.mjs")) {
  specs.add("specs/dataset_export_contract_v1.yaml");
}
process.stdout.write(`${JSON.stringify({
  schema: "evidence_service_spec_preflight_v1",
  required_specs: [...specs],
}, null, 2)}\n`);
