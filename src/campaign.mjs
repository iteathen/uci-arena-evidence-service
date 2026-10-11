import { createHash } from "node:crypto";
import { validateRuntimeBinding } from './runtime_v2_binding.mjs';
import {admitRuntimeCampaignParameters} from './runtime_v2_adapter.mjs';

const CORE_CONTROLS = ["30+0", "60+2", "180+0", "180+3"];
const STAGED_CONTROLS = ["40/120+5"];
const OPENING_SHARDS = ["startpos", "ruy_lopez", "queens_gambit", "sicilian"];
const STOCKFISH_DEPTHS = [8, 10, 12, 14];

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function enqueue(catalog, {
  adapter,
  targetId,
  shardId,
  priority,
  config,
  campaign = 'time_control_curve_v1',
}) {
  const jobIdentity = fingerprint({
    campaign,
    adapter,
    targetId: targetId ?? "active",
    shardId,
    config,
  });
  const existing = catalog.jobByFingerprint(jobIdentity);
  if (existing) return existing;
  const datasetId = catalog.createDataset({
    campaign,
    targetIdentity: targetId ? { target_id: targetId } : { source: "active_model_pointer" },
  });
  return catalog.enqueueJob({
    adapter,
    targetId,
    shardId,
    datasetId,
    priority,
    config: { campaign, ...config },
    fingerprint: jobIdentity,
  });
}

export function enqueueManagedUciMeasurements(catalog,{targetId,target,campaign,configuration={}}={}) {
  const runtime=validateRuntimeBinding(target?.runtimeBinding?.runtime_binding);
  const parameters=runtime.validateCampaign(campaign,configuration);
  admitRuntimeCampaignParameters(target,runtime,campaign,parameters);
  return runtime.campaigns.get(campaign).workloads.map((adapter,index)=>enqueue(catalog,{
    adapter,targetId,shardId:`managed-${adapter}`,priority:100-index,
    campaign,config:{parameters},
  }));
}

export function enqueueFirstCampaign(catalog, { targetId = null } = {}) {
  const jobs = [];
  jobs.push(enqueue(catalog, {
    adapter: "timing_profile",
    targetId,
    shardId: "deadline-provider-qualification",
    priority: 100,
    config: {
      repetitions: 30,
      engineOptions: [],
    },
  }));
  for (const [controlIndex, control] of CORE_CONTROLS.entries()) {
    jobs.push(enqueue(catalog, {
      adapter: "paired_sprt",
      targetId,
      shardId: `curve-${control}`,
      priority: 90,
      config: {
        evidenceMode: "curve",
        control,
        maxPairs: 1,
        pairIndex: controlIndex,
        maxPlies: 16,
        candidateOptions: ["McgsTemporalWeightProfile=AdaptiveCurveV1"],
        controlOptions: ["McgsTemporalWeightProfile=EarlyCurrent"],
      },
    }));
    for (const [openingIndex, openingId] of OPENING_SHARDS.entries()) {
      jobs.push(enqueue(catalog, {
        adapter: "paired_sprt",
        targetId,
        shardId: `paired-${control}-${openingId}`,
        priority: 80,
        config: {
          evidenceMode: "paired_strength",
          control,
          openingId,
          maxPairs: 1,
          pairIndex: controlIndex * OPENING_SHARDS.length + openingIndex,
          maxPlies: 600,
          adjudicationCp: 10_000,
          candidateOptions: ["McgsTemporalWeightProfile=AdaptiveCurveV1"],
          controlOptions: ["McgsTemporalWeightProfile=EarlyCurrent"],
        },
      }));
    }
    for (const opponentDepth of STOCKFISH_DEPTHS) {
      jobs.push(enqueue(catalog, {
        adapter: "paired_sprt",
        targetId,
        shardId: `stockfish-${control}-depth${opponentDepth}`,
        priority: 70,
        config: {
          evidenceMode: "stockfish_anchor",
          control,
          maxPairs: 1,
          pairIndex: controlIndex,
          maxPlies: 600,
          adjudicationCp: 10_000,
          opponentDepth,
          controlOptions: ["Threads=1", "Hash=64", "Ponder=false"],
        },
      }));
    }
  }
  for (const [controlIndex, control] of STAGED_CONTROLS.entries()) {
    const pairBase = CORE_CONTROLS.length * OPENING_SHARDS.length
      + controlIndex * OPENING_SHARDS.length;
    jobs.push(enqueue(catalog, {
      adapter: "paired_sprt",
      targetId,
      shardId: `curve-${control}`,
      priority: 60,
      config: {
        evidenceMode: "curve",
        control,
        maxPairs: 1,
        pairIndex: CORE_CONTROLS.length + controlIndex,
        maxPlies: 16,
        candidateOptions: ["McgsTemporalWeightProfile=AdaptiveCurveV1"],
        controlOptions: ["McgsTemporalWeightProfile=EarlyCurrent"],
      },
    }));
    for (const [openingIndex, openingId] of OPENING_SHARDS.entries()) {
      jobs.push(enqueue(catalog, {
        adapter: "paired_sprt",
        targetId,
        shardId: `paired-${control}-${openingId}`,
        priority: 50,
        config: {
          evidenceMode: "paired_strength",
          control,
          openingId,
          maxPairs: 1,
          pairIndex: pairBase + openingIndex,
          maxPlies: 600,
          adjudicationCp: 10_000,
          candidateOptions: ["McgsTemporalWeightProfile=AdaptiveCurveV1"],
          controlOptions: ["McgsTemporalWeightProfile=EarlyCurrent"],
        },
      }));
    }
    for (const opponentDepth of STOCKFISH_DEPTHS) {
      jobs.push(enqueue(catalog, {
        adapter: "paired_sprt",
        targetId,
        shardId: `stockfish-${control}-depth${opponentDepth}`,
        priority: 40,
        config: {
          evidenceMode: "stockfish_anchor",
          control,
          maxPairs: 1,
          pairIndex: CORE_CONTROLS.length + controlIndex,
          maxPlies: 600,
          adjudicationCp: 10_000,
          opponentDepth,
          controlOptions: ["Threads=1", "Hash=64", "Ponder=false"],
        },
      }));
    }
  }
  return jobs;
}

export function jobFingerprint(value) {
  return fingerprint(value);
}
