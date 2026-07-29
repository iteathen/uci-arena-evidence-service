import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { targetIdentity } from "./identity.mjs";
import { validateRuntimeContract } from "./runtime_contract.mjs";

const OUTPUT_SCHEMAS = Object.freeze({
  timing_profile: new Set(["uci_time_profile_v3"]),
  paired_sprt: new Set(["uci_arena_paired_sprt_v2"]),
  complete_game: new Set(["uci_arena_complete_game_matrix_v3"]),
});
const ADAPTERS = new Set(Object.keys(OUTPUT_SCHEMAS));
const QUALIFIER_OWNED_OPTIONS = new Set([
  "SearchCore",
  "Threads",
  "RootWorkers",
  "V2SplitDepth",
  "SearchGraphMB",
  "McgsCpuctPermille",
  "McgsOutstandingBatches",
  "McgsBookPriorBlendPermille",
  "McgsTimePolicy",
  "BackgroundSearch",
  "NNSpeculation",
  "ModelRoot",
  "NNBatchSize",
  "NNBatchWaitUs",
  "OnnxProvider",
  "IterativeTimeController",
  "TimeProfileProviderReserveUs",
  "TimeProfileBackupEmitReserveUs",
  "TimeProfileIterationForecastScalePermille",
  "Move Overhead",
  "Ponder",
  "OwnBook",
]);

export function isAllowedAdapter(adapter) {
  return ADAPTERS.has(String(adapter));
}

function stringArray(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  return [...value];
}

function integer(value, fallback, minimum, maximum, label) {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
    throw new Error(`${label} must be in ${minimum}..${maximum}`);
  }
  return selected;
}

function optionArguments(flag, options) {
  return stringArray(options, flag).flatMap((option) => {
    if (!/^[A-Za-z][A-Za-z0-9 _-]*=.+$/.test(option)) {
      throw new Error(`${flag} contains an invalid UCI option`);
    }
    return [flag, option];
  });
}

function targetOptionEntries(target) {
  if (!target.uciOptions || typeof target.uciOptions !== "object"
      || Array.isArray(target.uciOptions)) {
    throw new Error("target UCI options must be an object");
  }
  return Object.entries(target.uciOptions).map(([name, value]) => {
    if (!/^[A-Za-z][A-Za-z0-9 _-]*$/.test(name) || value === null
        || !new Set(["string", "number", "boolean"]).has(typeof value)) {
      throw new Error(`target UCI option ${JSON.stringify(name)} is invalid`);
    }
    return `${name}=${String(value)}`;
  });
}

function mergeOptions(...groups) {
  const merged = new Map();
  for (const group of groups) {
    for (const option of stringArray(group, "UCI options")) {
      const separator = option.indexOf("=");
      merged.set(option.slice(0, separator), option.slice(separator + 1));
    }
  }
  return [...merged].map(([name, value]) => `${name}=${value}`);
}

function targetOption(target, name, fallback) {
  return Object.hasOwn(target.uciOptions ?? {}, name) ? target.uciOptions[name] : fallback;
}

function topologyInteger(target, jobValue, optionName, fallback, minimum, maximum, label) {
  const raw = targetOption(target, optionName, jobValue ?? fallback);
  const text = String(raw).trim();
  if (!/^-?\d+$/.test(text)) throw new Error(`target UCI option ${optionName} must be an integer`);
  const parsed = Number(text);
  return integer(parsed, fallback, minimum, maximum, label);
}

function topologyBoolean(target, optionName, fallback) {
  const raw = targetOption(target, optionName, fallback);
  if (typeof raw === "boolean") return raw;
  const normalized = String(raw).trim().toLowerCase();
  if (new Set(["1", "true", "yes", "on"]).has(normalized)) return true;
  if (new Set(["0", "false", "no", "off"]).has(normalized)) return false;
  throw new Error(`target UCI option ${optionName} must be boolean`);
}

export function adapterCommand(job, target, config, attemptDirectory) {
  if (!ADAPTERS.has(job.adapter)) throw new Error(`adapter ${job.adapter} is not allow-listed`);
  const runtime = validateRuntimeContract(config.runtimeRoot);
  const value = job.config ?? {};
  const jobWorkspace = path.dirname(attemptDirectory);
  const environment = {
    ...process.env,
    UCI_ARENA_MODEL_ROOT: path.resolve(target.modelRoot),
    UCI_ARENA_MODEL_ID: target.modelId,
    UCI_ARENA_ONNX_PROVIDER: target.provider,
  };
  if (job.adapter === "timing_profile") {
    const searchCore = String(targetOption(target, "SearchCore", value.searchCore ?? "legacy"));
    const mcgsTimePolicy = String(targetOption(
      target,
      "McgsTimePolicy",
      searchCore === "mcgs" ? "RelativeClockTemporalV1" : "Legacy",
    ));
    if (searchCore === "mcgs" && mcgsTimePolicy !== "RelativeClockTemporalV1") {
      throw new Error(
        `target McgsTimePolicy must be RelativeClockTemporalV1, got ${mcgsTimePolicy}`,
      );
    }
    const targetOptions = targetOptionEntries(target);
    const extraOptions = mergeOptions(
      targetOptions.filter((option) => !QUALIFIER_OWNED_OPTIONS.has(option.slice(0, option.indexOf("=")))),
      value.engineOptions ?? [],
    );
    const candidate = path.join(jobWorkspace, "uci_time_profile_candidate.json");
    const checkpoint = path.join(jobWorkspace, "uci_time_profile_checkpoint.json");
    const args = [
      runtime.entrypoints.timing_profile,
      "qualify",
      "--engine", target.enginePath,
      "--model-root", target.modelRoot,
      "--runtime-models-root", config.runtimeModelsRoot,
      "--expected-model-id", target.modelId,
      "--expected-model-fingerprint", String(target.modelFingerprint),
      "--provider", String(target.provider),
      "--search-core", searchCore,
      "--threads", String(topologyInteger(target, value.threads, "Threads", 1, 1, 512, "threads")),
      "--root-workers", String(topologyInteger(
        target,
        value.rootWorkers,
        "RootWorkers",
        0,
        0,
        512,
        "rootWorkers",
      )),
      "--split-depth", String(topologyInteger(
        target,
        value.splitDepth,
        "V2SplitDepth",
        5,
        1,
        64,
        "splitDepth",
      )),
      "--search-graph-mb", String(topologyInteger(
        target,
        value.searchGraphMb,
        "SearchGraphMB",
        512,
        64,
        4_096,
        "searchGraphMb",
      )),
      "--mcgs-cpuct-permille", String(topologyInteger(
        target,
        value.mcgsCpuctPermille,
        "McgsCpuctPermille",
        1_500,
        100,
        10_000,
        "mcgsCpuctPermille",
      )),
      "--mcgs-outstanding-batches", String(topologyInteger(
        target,
        value.mcgsOutstandingBatches,
        "McgsOutstandingBatches",
        2,
        1,
        4,
        "mcgsOutstandingBatches",
      )),
      "--mcgs-book-prior-blend-permille", String(topologyInteger(
        target,
        value.mcgsBookPriorBlendPermille,
        "McgsBookPriorBlendPermille",
        250,
        0,
        500,
        "mcgsBookPriorBlendPermille",
      )),
      "--batch-size", String(topologyInteger(
        target,
        value.batchSize,
        "NNBatchSize",
        0,
        0,
        256,
        "batchSize",
      )),
      "--batch-wait-us", String(topologyInteger(
        target,
        value.batchWaitUs,
        "NNBatchWaitUs",
        0,
        0,
        2_000,
        "batchWaitUs",
      )),
      "--background-search", String(topologyBoolean(target, "BackgroundSearch", false)),
      "--nn-speculation", String(topologyBoolean(target, "NNSpeculation", false)),
      "--move-overhead-ms", String(topologyInteger(
        target,
        value.moveOverheadMs,
        "Move Overhead",
        50,
        0,
        5_000,
        "moveOverheadMs",
      )),
      "--repetitions", String(integer(value.repetitions, 3, 2, 100, "repetitions")),
      "--publication-mode", "candidate",
      "--candidate-out", candidate,
      "--checkpoint", checkpoint,
      "--resume",
      ...optionArguments("--engine-option", extraOptions),
    ];
    return {
      executable: process.execPath,
      args,
      environment,
      outputs: [{ filename: candidate, kind: "json" }],
    };
  }
  if (job.adapter === "paired_sprt") {
    const targetOptions = mergeOptions(
      targetOptionEntries(target),
      [`ModelRoot=${path.resolve(target.modelRoot)}`],
      [`OnnxProvider=${target.provider}`],
    );
    const output = path.join(jobWorkspace, "paired_sprt.json");
    const evidenceMode = String(value.evidenceMode ?? "paired_strength");
    if (!new Set(["curve", "paired_strength", "stockfish_anchor"]).has(evidenceMode)) {
      throw new Error("paired_sprt evidenceMode is invalid");
    }
    const control = String(value.control ?? "").trim();
    if (control && !/^\d+(?:\/\d+)?(?:\+\d+)?$/.test(control)) {
      throw new Error("paired_sprt control is invalid");
    }
    const pairIndex = integer(value.pairIndex, 0, 0, 1_000_000, "pairIndex");
    const stockfishAnchor = evidenceMode === "stockfish_anchor";
    const args = [
      runtime.entrypoints.paired_sprt,
      "--engine", target.enginePath,
      "--stockfish", config.stockfish,
      "--referee", config.referee,
      "--model-root", target.modelRoot,
      "--output", output,
      "--mode", "sprt",
      "--movetime-ms", String(integer(value.movetimeMs, 25, 1, 60_000, "movetimeMs")),
      "--max-pairs", String(integer(value.maxPairs, 1, 1, 10_000, "maxPairs")),
      "--pair-index", String(pairIndex),
      "--max-plies", String(integer(
        value.maxPlies,
        evidenceMode === "curve" ? 16 : 600,
        4,
        20_000,
        "maxPlies",
      )),
      "--adjudication-cp", String(integer(
        value.adjudicationCp,
        evidenceMode === "curve" ? 700 : 10_000,
        0,
        100_000,
        "adjudicationCp",
      )),
      "--adjudication-depth", String(integer(
        value.adjudicationDepth,
        16,
        1,
        64,
        "adjudicationDepth",
      )),
      "--expected-model-id", target.modelId,
      "--expected-model-fingerprint", String(target.modelFingerprint),
      "--expected-provider", target.provider,
      "--expected-engine-sha256", target.engineSha256,
      "--resume",
      "--evidence-only",
      "--symmetric-defaults",
      ...optionArguments("--candidate-option", mergeOptions(
        targetOptions,
        value.candidateOptions ?? [],
      )),
      ...optionArguments("--control-option", stockfishAnchor
        ? value.controlOptions ?? ["Threads=1", "Hash=64", "Ponder=false"]
        : mergeOptions(targetOptions, value.controlOptions ?? [])),
    ];
    if (control) args.push("--time-control", control);
    if (value.gameManifest) args.push("--manifest", path.resolve(value.gameManifest));
    if (value.singleGameIndex !== undefined) {
      args.push(
        "--single-game-index",
        String(integer(value.singleGameIndex, null, 0, 1, "singleGameIndex")),
      );
    }
    if (stockfishAnchor) {
      args.push(
        "--opponent", "stockfish",
        "--opponent-depth", String(integer(value.opponentDepth, null, 1, 64, "opponentDepth")),
      );
    }
    return {
      executable: process.execPath,
      args,
      environment,
      outputs: [{ filename: output, kind: "json" }],
    };
  }
  const output = path.join(jobWorkspace, "complete_game.json");
  const args = [
    runtime.entrypoints.complete_game,
    "--engine", target.enginePath,
    "--stockfish", config.stockfish,
    "--referee", config.referee,
    "--model-root", target.modelRoot,
    "--output", output,
    "--expected-model-id", target.modelId,
    "--expected-model-fingerprint", String(target.modelFingerprint),
    "--expected-provider", target.provider,
    "--root-workers", String(topologyInteger(
      target,
      value.rootWorkers,
      "RootWorkers",
      1,
      1,
      16,
      "rootWorkers",
    )),
    "--split-depth", String(topologyInteger(
      target,
      value.splitDepth,
      "V2SplitDepth",
      5,
      2,
      64,
      "splitDepth",
    )),
    "--expected-batch-size", String(topologyInteger(
      target,
      value.expectedBatchSize,
      "NNBatchSize",
      1,
      1,
      256,
      "expectedBatchSize",
    )),
    "--threads", String(topologyInteger(
      target,
      value.threads,
      "Threads",
      1,
      1,
      256,
      "threads",
    )),
    "--time-ms", stringArray(value.timeMs ?? ["25", "100", "500"], "timeMs").join(","),
    "--allow-shared-gpu-diagnostic",
  ];
  if (config.gpuIsolationAttestation) {
    args.push("--gpu-isolation-attestation", config.gpuIsolationAttestation);
  }
  return {
    executable: process.execPath,
    args,
    environment,
    outputs: [{ filename: output, kind: "json" }],
    selfGuarded: true,
  };
}

function jsonLines(bytes) {
  const records = [];
  let start = 0;
  for (let index = 0; index < bytes.length; ++index) {
    if (bytes[index] !== 0x0a) continue;
    const raw = bytes.subarray(start, index + 1);
    start = index + 1;
    if (raw.toString("utf8").trim()) records.push(raw);
  }
  if (start < bytes.length) {
    const raw = bytes.subarray(start);
    if (raw.toString("utf8").trim()) records.push(raw);
  }
  return records;
}

function readOutputs(outputs) {
  const entries = [];
  for (const output of outputs) {
    if (!existsSync(output.filename)) continue;
    const bytes = readFileSync(output.filename);
    if (output.kind === "json") {
      entries.push({ record: JSON.parse(bytes.toString("utf8")), raw: bytes });
    } else {
      for (const raw of jsonLines(bytes)) {
        entries.push({ record: JSON.parse(raw.toString("utf8")), raw });
      }
    }
  }
  return entries;
}

function contentAddressedArtifact(config, bytes) {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const directory = path.join(config.paths.artifacts, sha256.slice(0, 2));
  const filename = path.join(directory, `${sha256}.raw`);
  if (!existsSync(filename)) {
    mkdirSync(directory, { recursive: true });
    const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, bytes);
    try {
      renameSync(temporary, filename);
    } catch (error) {
      if (!existsSync(filename)) throw error;
    } finally {
      try { if (existsSync(temporary)) unlinkSync(temporary); } catch {}
    }
  }
  return { sha256, filename, sizeBytes: statSync(filename).size };
}

function normalizedSha256(value) {
  return String(value ?? "").replace(/^sha256:/i, "").toLowerCase();
}

function requireEqual(actual, expected, label) {
  if (String(actual ?? "") !== String(expected ?? "")) {
    throw new Error(
      `${label} expected ${JSON.stringify(String(expected ?? ""))}`
      + ` got ${JSON.stringify(String(actual ?? ""))}`,
    );
  }
}

function validateRuntimeStatus(status, target, label) {
  if (!status || typeof status !== "object") throw new Error(`${label} runtime identity is missing`);
  requireEqual(status.model_id, target.modelId, `${label}.model_id`);
  requireEqual(status.model_fingerprint, target.modelFingerprint, `${label}.model_fingerprint`);
  requireEqual(status.provider_effective, target.provider, `${label}.provider_effective`);
  if (target.hardwareDriverFingerprint) {
    requireEqual(
      status.hardware_driver_fingerprint,
      target.hardwareDriverFingerprint,
      `${label}.hardware_driver_fingerprint`,
    );
  }
}

function validateSourceIdentity(job, record, records, target) {
  if (job.adapter === "timing_profile") {
    requireEqual(
      normalizedSha256(record.identity?.engine?.executable_sha256),
      target.engineSha256,
      "timing profile engine SHA-256",
    );
    requireEqual(record.identity?.model?.model_id, target.modelId, "timing profile model_id");
    requireEqual(
      record.identity?.model?.model_fingerprint,
      target.modelFingerprint,
      "timing profile model_fingerprint",
    );
    requireEqual(
      record.identity?.search?.provider_effective,
      target.provider,
      "timing profile provider",
    );
    if (target.hardwareDriverFingerprint) {
      requireEqual(
        record.identity?.provider?.hardware_driver_fingerprint,
        target.hardwareDriverFingerprint,
        "timing profile hardware identity",
      );
    }
    return;
  }
  if (job.adapter === "paired_sprt") {
    requireEqual(
      normalizedSha256(record.runtime_identity?.engine_sha256),
      target.engineSha256,
      "paired SPRT engine SHA-256",
    );
    validateRuntimeStatus(record.runtime_identity?.candidate, target, "paired SPRT candidate");
    if (record.opponent?.kind === "engine") {
      validateRuntimeStatus(record.runtime_identity?.control, target, "paired SPRT control");
    } else {
      requireEqual(record.opponent?.kind, "stockfish", "paired SPRT opponent kind");
      requireEqual(
        record.runtime_identity?.control?.fixed_depth,
        job.config?.opponentDepth,
        "Stockfish anchor depth",
      );
    }
    return;
  }
  requireEqual(
    record.deployed_model?.expected_model_id,
    target.modelId,
    "complete-game model_id",
  );
  requireEqual(
    record.deployed_model?.expected_model_fingerprint,
    target.modelFingerprint,
    "complete-game model_fingerprint",
  );
  requireEqual(
    record.deployed_model?.expected_provider,
    target.provider,
    "complete-game provider",
  );
}

function validateAdapterRecords(job, records, target) {
  if (records.length === 0) throw new Error("adapter produced no recognized artifacts");
  for (const record of records) {
    const sourceSchema = String(record?.schema ?? "");
    if (!OUTPUT_SCHEMAS[job.adapter]?.has(sourceSchema)) {
      throw new Error(
        `adapter ${job.adapter} produced incompatible schema ${sourceSchema || "<missing>"}`,
      );
    }
    if (Array.isArray(record.failures) && record.failures.length > 0) {
      const failures = record.failures.map((failure) => {
        if (typeof failure === "string") return failure;
        return String(failure?.message ?? JSON.stringify(failure));
      });
      throw new Error(
        `adapter ${job.adapter} reported failure: ${failures.join("; ")}`,
      );
    }
    validateSourceIdentity(job, record, records, target);
  }
}

function authorityFor(job, record, records, resource) {
  const clean = resource?.performance_authority === true
    && resource?.interval_status === "finalized";
  const reasons = [];
  if (!clean) reasons.push(...(resource?.problems ?? ["resource_interval_not_authoritative"]));
  let timing = clean;
  let strength = clean && resource?.strength_authority === true;
  let profilePublication = false;
  if (job.adapter === "timing_profile") {
    timing = timing && record?.qualified === true && record?.gates?.passed === true;
    profilePublication = timing
      && resource?.default_tuning_authority === true
      && record?.permissions?.provider_safety_qualified === true
      && record?.permissions?.adaptive_play_qualified === false;
    strength = false;
    if (!profilePublication) reasons.push("timing_profile_publication_gates_not_complete");
  } else if (job.adapter === "complete_game") {
    strength = false;
    reasons.push("complete_game_matrix_is_diagnostic_only");
  } else if (job.adapter === "paired_sprt") {
    const pairs = record?.sprt?.pair_records ?? [];
    const games = pairs.flatMap((pair) => pair.games ?? []);
    const completeTiming = games.length > 0
      && (record.failures?.length ?? 0) === 0
      && games.every((game) => (
        Array.isArray(game.records)
        && game.records.length > 0
        && game.termination !== "flag_fall"
        && game.termination !== "engine_failure"
      ));
    timing = timing && completeTiming;
    const completePairs = pairs.length > 0 && pairs.every((pair) => (
      Array.isArray(pair.games)
      && pair.games.length === 2
      && new Set(pair.games.map((game) => game.candidate_color)).size === 2
      && pair.games.every((game) => (
        new Set(["white", "black"]).has(game.candidate_color)
        && new Set(["1-0", "0-1", "1/2-1/2"]).has(game.result)
        && game.complete === true
        && !String(game.termination ?? "").includes("max_ply")
        && game.termination !== "max_plies_draw"
      ))
    ));
    strength = strength
      && record?.schema === "uci_arena_paired_sprt_v2"
      && completePairs
      && (record.failures?.length ?? 0) === 0
      && new Set(["paired_strength", "stockfish_anchor"]).has(job.config?.evidenceMode);
    if (!strength) reasons.push("paired_sprt_incomplete");
  }
  return {
    diagnostic: true,
    timing,
    strength,
    profile_publication: profilePublication,
    reasons: [...new Set(reasons.filter(Boolean))],
  };
}

function axesFor(job, record) {
  if (record.schema === "uci_time_profile_v3") {
    return {
      workload: job.adapter,
      campaign: job.config.campaign ?? "",
      control: job.config.control ?? null,
      cache_states: [...new Set((record.samples ?? []).map((sample) => sample.temperature))],
      positions: [...new Set((record.samples ?? []).map((sample) => sample.case_id))],
      search_topology: record.identity?.search ?? null,
      provider_identity: record.identity?.provider ?? null,
    };
  }
  return {
    workload: job.config?.evidenceMode ?? job.adapter,
    campaign: job.config.campaign ?? "",
    control: record.time_control ?? job.config.control ?? null,
    color_pair_shard: job.shardId,
    opponent: record.opponent ?? null,
    opening_manifest_sha256: record.run_fingerprint ?? null,
    search_topology: record.runtime_identity ?? null,
    cache_state: record.temperature ?? null,
    position: record.case_id ?? null,
  };
}

function metricsFor(record) {
  if (record.schema === "uci_arena_paired_sprt_v2") {
    const games = (record.sprt?.pair_records ?? []).flatMap((pair) => pair.games ?? []);
    const candidateMoves = games.flatMap((game) => (
      (game.records ?? []).filter((move) => move.owner === "candidate")
    ));
    return {
      hypotheses: record.sprt?.hypotheses ?? null,
      state: record.sprt?.state ?? null,
      pentanomial: record.sprt?.pentanomial ?? null,
      pairs: record.sprt?.pairs ?? 0,
      games: record.sprt?.games ?? 0,
      tactical: record.tactical ?? null,
      game_results: games.map((game) => ({
        game_id: game.game_id,
        candidate_color: game.candidate_color,
        result: game.result,
        termination: game.termination,
        complete: game.complete,
        final_clocks_ms: game.clocks_ms ?? null,
      })),
      elapsed_ms: candidateMoves.map((move) => move.elapsed_ms),
      depth: candidateMoves.map((move) => move.score?.depth ?? null),
      nodes: candidateMoves.map((move) => move.score?.nodes ?? null),
      nps: candidateMoves.map((move) => move.score?.nps ?? null),
      engine_time_ms: candidateMoves.map((move) => move.score?.engine_time_ms ?? null),
      provider_work: candidateMoves.map((move) => move.score?.provider_work ?? null),
      internal_time_limit_ms: candidateMoves.map((move) => move.score?.time_limit_ms ?? null),
      deadline_budget_ms: candidateMoves.map(
        (move) => move.score?.deadline_budget_ms ?? null,
      ),
      command_elapsed_ms: candidateMoves.map(
        (move) => move.score?.command_elapsed_ms ?? null,
      ),
      deadline_overshoot_ms: candidateMoves.map(
        (move) => move.score?.deadline_overshoot_ms ?? null,
      ),
      time_strategy: candidateMoves.map((move) => move.score?.time_strategy ?? null),
      score_trace: candidateMoves.map((move) => move.score_trace ?? []),
      wdl: candidateMoves.map((move) => move.score?.wdl ?? null),
      book_hit: candidateMoves.map((move) => move.score?.opening_book_hit ?? null),
      ponder: candidateMoves.map((move) => ({
        move: move.ponder ?? "",
        state: move.score?.ponder_state ?? null,
      })),
      provider: candidateMoves.map((move) => move.score?.model_provider ?? null),
      provider_numeric_fingerprint: candidateMoves.map(
        (move) => move.score?.provider_numeric_fingerprint ?? null,
      ),
      hardware_driver_fingerprint: candidateMoves.map(
        (move) => move.score?.hardware_driver_fingerprint ?? null,
      ),
      clocks: candidateMoves.map((move) => move.clock ?? null),
      moves: candidateMoves.map((move) => move.move),
    };
  }
  if (record.schema === "uci_arena_complete_game_matrix_v3") {
    return {
      summary: record.summary ?? null,
      runtime_contract: record.runtime_contract ?? null,
      completed: Boolean(record.completed),
    };
  }
  return record.calibration ?? record.summary ?? record.gates ?? {};
}

function outcomeFor(record) {
  return {
    result: record.result ?? null,
    termination: record.termination ?? null,
    failure: record.failure ?? null,
    qualified: record.qualified ?? null,
    gates: record.gates ?? null,
    status: record.status ?? null,
  };
}

export function harvestAdapter(job, target, command, config, catalog, resource) {
  const entries = readOutputs(command.outputs);
  const records = entries.map((entry) => entry.record);
  validateAdapterRecords(job, records, target);
  const envelopes = [];
  for (const { record, raw } of entries) {
    const sourceSchema = String(record?.schema ?? "");
    const artifact = contentAddressedArtifact(config, raw);
    catalog.registerArtifact({
      sha256: artifact.sha256,
      schema: sourceSchema,
      filename: artifact.filename,
      sizeBytes: artifact.sizeBytes,
    });
    const envelope = {
      schema: "uci_arena_observation_envelope_v1",
      observation_id: randomUUID(),
      dataset_id: job.datasetId,
      job_id: job.id,
      shard_id: job.shardId,
      recorded_at: new Date().toISOString(),
      adapter: job.adapter,
      source_schema: sourceSchema,
      raw_sha256: artifact.sha256,
      target_identity: targetIdentity(target),
      axes: axesFor(job, record),
      metrics: metricsFor(record),
      outcome: outcomeFor(record),
      resource,
      authority: authorityFor(job, record, records, resource),
    };
    catalog.addObservation(envelope);
    envelopes.push(envelope);
  }
  return { records, envelopes };
}

export function profileCandidate(records) {
  return records.find((record) => record?.schema === "uci_time_profile_v3") ?? null;
}
