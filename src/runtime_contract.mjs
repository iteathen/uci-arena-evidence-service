import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const CONTRACT_RELATIVE = "contracts/evidence-runtime-contract.json";
const EXPECTED_ENTRYPOINTS = Object.freeze({
  timing_profile: "engine/tools/qualify_uci_time_profile.mjs",
  paired_sprt: "arena/run_sprt_match.mjs",
  complete_game: "arena/run_complete_game_matrix.mjs",
});
const EXPECTED_REFEREE = process.platform === "win32"
  ? "bin/uci_arena_complete_game_referee.exe"
  : "bin/uci_arena_complete_game_referee";

function safeRuntimePath(runtimeRoot, relative) {
  if (typeof relative !== "string"
      || relative.includes("\\")
      || path.isAbsolute(relative)) {
    throw new Error("evidence runtime contract contains an unsafe entrypoint");
  }
  const normalized = path.posix.normalize(relative);
  if (normalized !== relative
      || normalized === "."
      || normalized.startsWith("../")) {
    throw new Error("evidence runtime contract contains an escaping entrypoint");
  }
  const root = path.resolve(runtimeRoot);
  const resolved = path.resolve(root, ...relative.split("/"));
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("evidence runtime contract contains an escaping entrypoint");
  }
  return resolved;
}

export function validateRuntimeContract(runtimeRoot) {
  const contractPath = path.join(
    path.resolve(runtimeRoot),
    ...CONTRACT_RELATIVE.split("/"),
  );
  if (!existsSync(contractPath) || !statSync(contractPath).isFile()) {
    throw new Error(
      `uci_arena_evidence.runtime contract is unavailable: ${contractPath}`,
    );
  }
  let contract;
  try {
    contract = JSON.parse(readFileSync(contractPath, "utf8"));
  } catch {
    throw new Error("uci_arena_evidence.runtime contract is malformed");
  }
  if (contract?.schema !== "uci_arena_evidence_runtime_v1"
      || contract.component_id !== "uci_arena_evidence.runtime"
      || !/^\d+\.\d+\.\d+(?:[-.][A-Za-z0-9.-]+)?$/u.test(
        contract.component_version ?? "",
      )
      || contract.target_triple !== (
        process.platform === "win32" ? "windows-x86_64" : "linux-x86_64"
      )
      || Object.keys(contract.entrypoints ?? {}).sort().join(",")
        !== Object.keys(EXPECTED_ENTRYPOINTS).sort().join(",")
      || Object.keys(contract.native_entrypoints ?? {}).join(",") !== "referee"
      || contract.native_entrypoints.referee !== EXPECTED_REFEREE) {
    throw new Error("uci_arena_evidence.runtime contract identity is incompatible");
  }
  const entrypoints = {};
  for (const [name, expected] of Object.entries(EXPECTED_ENTRYPOINTS)) {
    const relative = contract.entrypoints[name];
    if (relative !== expected) {
      throw new Error(
        `uci_arena_evidence.runtime ${name} entrypoint is incompatible`,
      );
    }
    const filename = safeRuntimePath(runtimeRoot, relative);
    if (!existsSync(filename) || !statSync(filename).isFile()) {
      throw new Error(
        `uci_arena_evidence.runtime ${name} entrypoint is unavailable`,
      );
    }
    entrypoints[name] = filename;
  }
  const referee = safeRuntimePath(runtimeRoot, EXPECTED_REFEREE);
  if (!existsSync(referee) || !statSync(referee).isFile()) {
    throw new Error("uci_arena_evidence.runtime referee entrypoint is unavailable");
  }
  entrypoints.referee = referee;
  return Object.freeze({
    componentVersion: contract.component_version,
    contractPath,
    entrypoints: Object.freeze(entrypoints),
  });
}
