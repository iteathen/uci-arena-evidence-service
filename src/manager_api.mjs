import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";

import { listQualifiedProfiles } from "./profiles.mjs";
import { enqueueFirstCampaign, enqueueManagedUciMeasurements } from "./campaign.mjs";
import { validateRuntimeBinding, admitRuntimeTarget, RuntimeCapabilityUnsupported } from './runtime_v2_binding.mjs';
import { sha256File } from "./identity.mjs";
import { recoverStartup } from "./platform_startup.mjs";

const API_SCHEMA = "uci_arena_manager_service_api_v1";
const API_VERSION = "1.0";
const COMPONENT_ID = "uci_arena_evidence.service";
const COMPONENT_VERSION = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;
const OUTPUT_SCHEMA = "uci_arena_service_output_v1";
const OPERATIONS = Object.freeze([
  "describe",
  "status",
  "outputs_list",
  "outputs_inspect",
  "config_validate",
  "orchestration_status",
  "target_register",
  "campaign_enqueue",
  "job_control",
  "startup_recover",
]);

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ORCHESTRATION_TARGET_LIMIT = 64;
const ORCHESTRATION_JOB_LIMIT = 512;

function envelope(operation, payload) {
  return {
    schema: API_SCHEMA,
    api_version: API_VERSION,
    component_id: COMPONENT_ID,
    component_version: COMPONENT_VERSION,
    operation,
    ok: true,
    payload,
  };
}

export function apiError(operation, error) {
  return {
    schema: API_SCHEMA,
    api_version: API_VERSION,
    component_id: COMPONENT_ID,
    component_version: COMPONENT_VERSION,
    operation,
    ok: false,
    error: {
      code: "service_api_rejected",
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

function datasetOutput(dataset) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
    .test(dataset.id ?? "")) {
    throw new Error("Evidence dataset output identity is malformed");
  }
  return {
    schema: OUTPUT_SCHEMA,
    output_id: `dataset:${dataset.id}`,
    output_kind: "evidence.dataset",
    created_at: dataset.createdAt,
    state: {
      lifecycle: dataset.state,
      immutable: dataset.state === "completed",
      completed_at: dataset.completedAt,
    },
    authority: {
      diagnostic: Boolean(dataset.authority?.diagnostic),
      timing: Boolean(dataset.authority?.timing),
      strength: Boolean(dataset.authority?.strength),
      profile_publication: Boolean(dataset.authority?.profile_publication),
      reasons: Array.isArray(dataset.authority?.reasons)
        ? dataset.authority.reasons.map(String)
        : [],
    },
    compatibility: {
      dataset_schema: dataset.schema,
      target_identity: dataset.targetIdentity,
      campaign: dataset.campaign,
    },
    summary: {
      observation_count: dataset.observationCount,
    },
    materialization: {
      transport: "typed_cli_arguments",
      arguments: [
        "dataset",
        "export",
        "--id",
        dataset.id,
        "--out",
        "{manager_destination}",
        "--format",
        "jsonl",
      ],
    },
  };
}

function profileOutput(profile) {
  if (!/^[0-9a-f]{64}$/u.test(profile.sha256 ?? "")) {
    throw new Error("Evidence profile output identity is malformed");
  }
  return {
    schema: OUTPUT_SCHEMA,
    output_id: `profile:${profile.sha256}`,
    output_kind: "timing_profile.qualified",
    created_at: profile.publishedAt,
    state: {
      immutable: true,
      source: profile.source,
    },
    authority: {
      diagnostic: false,
      timing: true,
      strength: false,
      profile_publication: Boolean(profile.servicePublication),
      provider_safety_qualified:
        Boolean(profile.permissions.provider_safety_qualified),
      forecast_shadow_qualified:
        Boolean(profile.permissions.forecast_shadow_qualified),
      adaptive_play_qualified:
        Boolean(profile.permissions.adaptive_play_qualified),
    },
    compatibility: {
      profile_schema: profile.profileSchema,
      identity_sha256: profile.identitySha256,
      target_identity: profile.targetIdentity,
    },
    artifact: {
      path: profile.path,
      sha256: profile.sha256,
    },
    provenance: {
      service_publication: profile.servicePublication,
    },
  };
}

function allOutputs(catalog, config) {
  return [
    ...catalog.datasets().map(datasetOutput),
    ...listQualifiedProfiles(config, catalog).map(profileOutput),
  ].sort((left, right) => left.output_id.localeCompare(right.output_id));
}

function cursorFor(outputs) {
  return createHash("sha256").update(JSON.stringify(outputs.map((output) => ({
    output_id: output.output_id,
    state: output.state,
    authority: output.authority,
  })))).digest("hex");
}

export function describeApi() {
  return envelope("describe", {
    transport: "cli_json",
    invocation: ["api"],
    operations: [...OPERATIONS],
    output_schemas: [OUTPUT_SCHEMA],
    output_kinds: ["evidence.dataset", "timing_profile.qualified"],
    configuration_schema: "uci_arena_evidence_service_config_v1",
    status_schema: "uci_arena_evidence_status_v1",
  });
}

export function statusApi(catalog) {
  return envelope("status", { status: catalog.status() });
}

export function listOutputsApi(catalog, config, cursor = "") {
  if (cursor && !/^[0-9a-f]{64}$/u.test(cursor)) {
    throw new Error("Evidence output cursor is malformed");
  }
  const outputs = allOutputs(catalog, config);
  const currentCursor = cursorFor(outputs);
  return envelope("outputs_list", {
    cursor: currentCursor,
    unchanged: cursor === currentCursor,
    outputs: cursor === currentCursor ? [] : outputs,
  });
}

export function inspectOutputApi(catalog, config, outputId) {
  if (!/^(?:dataset:[0-9a-f-]{36}|profile:[0-9a-f]{64})$/iu.test(outputId ?? "")) {
    throw new Error("Evidence output id is malformed");
  }
  const output = allOutputs(catalog, config)
    .find((candidate) => candidate.output_id === outputId);
  if (!output) throw new Error(`Evidence output does not exist: ${outputId}`);
  return envelope("outputs_inspect", { output });
}

export function validateConfigApi(config) {
  return envelope("config_validate", {
    valid: true,
    configuration_schema: "uci_arena_evidence_service_config_v1",
    workspace: config.workspace,
    runtime_component_id: "uci_arena_evidence.runtime",
  });
}

export async function startupRecoverApi(config, recoverImpl = recoverStartup) {
  const startup = await recoverImpl(config);
  return envelope("startup_recover", {
    startup,
    recovery_requested: startup.recoveryRequested === true,
    registration_mutated: startup.registrationMutated === true,
  });
}

function targetSummary(target, includeSchemas=true) {
  if (!UUID_V4.test(target.id ?? "")) throw new Error("Evidence target id is malformed");
  if(target.runtimeBinding) {
    const projection=target.runtimeBinding.projection;
    return {id:target.id,label:target.label,target_schema:'uci_arena_evidence_target_v2',engine_sha256:target.engineSha256,
      component_id:projection.component_id,component_version:projection.component_version,runtime_identity_sha256:projection.runtime_identity_sha256,
      capabilities:projection.capabilities,campaigns:projection.campaigns.map(campaign=>includeSchemas?campaign:{name:campaign.name,workloads:campaign.workloads}),
      identity_scope:'registered_snapshot',created_at:target.createdAt};
  }
  return {
    id: target.id,
    label: String(target.label ?? "").slice(0, 256),
    model_id: String(target.modelId ?? "").slice(0, 256),
    model_fingerprint: String(target.modelFingerprint ?? "").slice(0, 512),
    engine_sha256: String(target.engineSha256 ?? "").slice(0, 64),
    provider: String(target.provider ?? "").slice(0, 128),
    created_at: target.createdAt,
  };
}

function normalizedUciOptions(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Evidence target UCI options must be an object");
  }
  const entries = Object.entries(value);
  if (entries.length > 128) throw new Error("Evidence target has too many UCI options");
  const normalized = {};
  for (const [name, optionValue] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    if (!name.length || name.length > 128 || /[\u0000-\u001f\u007f]/u.test(name)) {
      throw new Error("Evidence target UCI option name is invalid");
    }
    if (!["string", "boolean", "number"].includes(typeof optionValue)
        || (typeof optionValue === "number" && !Number.isSafeInteger(optionValue))
        || (typeof optionValue === "string" && optionValue.length > 512)) {
      throw new Error(`Evidence target UCI option ${name} has an invalid value`);
    }
    normalized[name] = optionValue;
  }
  return normalized;
}

function exactPath(value, kind) {
  const candidate = String(value ?? "");
  if (!path.isAbsolute(candidate)) throw new Error(`Evidence target ${kind} path must be absolute`);
  const resolved = path.resolve(candidate);
  const status = lstatSync(resolved);
  if (kind === "engine" ? !status.isFile() : !status.isDirectory()) {
    throw new Error(`Evidence target ${kind} path has the wrong type`);
  }
  return resolved;
}

export function registerTargetApi(catalog, input, config) {
  const v2 = input.schema === 'uci_arena_evidence_target_v2';
  if (input.schema !== undefined && !v2 && input.schema !== 'uci_arena_evidence_target_v1') {
    throw new Error('Evidence target schema is incompatible');
  }
  if(v2) {
    if(Buffer.byteLength(JSON.stringify(input))>8192)throw new Error('target JSON exceeds 8192-byte CLI bound');
    let target;
    try{target=admitRuntimeTarget(input);}catch(error){if(error instanceof RuntimeCapabilityUnsupported)return envelope('target_register',{schema:'uci_arena_evidence_target_register_v1',status:'unsupported',code:error.code,reason:error.message,created:false});throw error;}
    const existing=catalog.findExactTarget(target);const registered=existing??catalog.addTarget(target);
    return envelope('target_register',{schema:'uci_arena_evidence_target_register_v1',status:'supported',created:!existing,target:targetSummary(registered)});
  }
  const modelId = String(input.modelId ?? "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(modelId)) {
    throw new Error("Evidence target model id is invalid");
  }
  const modelFingerprint = String(input.modelFingerprint ?? "");
  if (!/^\d{1,20}$/u.test(modelFingerprint)) {
    throw new Error("Evidence target model fingerprint is invalid");
  }
  const provider = String(input.provider ?? "");
  if (!new Set(["auto", "cpu", "directml", "cuda"]).has(provider)) {
    throw new Error("Evidence target provider is invalid");
  }
  const providerFingerprint = String(input.hardwareDriverFingerprint ?? "");
  if (providerFingerprint && !/^\d{1,20}$/u.test(providerFingerprint)) {
    throw new Error("Evidence target provider fingerprint is invalid");
  }
  const label = String(input.label || modelId);
  if (!label.length || label.length > 256 || /[\u0000-\u001f\u007f]/u.test(label)) {
    throw new Error("Evidence target label is invalid");
  }
  const target = {
    label,
    modelId,
    modelRoot: exactPath(input.modelRoot, "model root"),
    modelFingerprint,
    enginePath: exactPath(input.enginePath, "engine"),
    provider,
    hardwareDriverFingerprint: providerFingerprint,
    uciOptions: normalizedUciOptions(input.uciOptions ?? {}),
  };
  target.engineSha256 = sha256File(target.enginePath);
  const existing = catalog.findExactTarget(target);
  const registered = existing ?? catalog.addTarget(target);
  return envelope("target_register", {
    schema: "uci_arena_evidence_target_register_v1",
    created: !existing,
    target: targetSummary(registered),
  });
}

function boundedDiagnostic(value) {
  return String(value ?? "")
    .slice(0, 2_048)
    .replace(/[A-Za-z]:[\\/][^\s,;)]*/gu, "[path]")
    .replace(/\\\\[^\\\s]+\\[^\s,;)]*/gu, "[path]")
    .replace(/(^|[\s=:(])\/(?:[^\s,;)]+\/?)+/gu, "$1[path]");
}

function jobSummary(job) {
  if (!UUID_V4.test(job.id ?? "")) throw new Error("Evidence job id is malformed");
  return {
    id: job.id,
    adapter: String(job.adapter ?? "").slice(0, 64),
    state: String(job.state ?? "").slice(0, 64),
    priority: Number(job.priority),
    target_id: job.targetId,
    shard_id: String(job.shardId ?? "").slice(0, 256),
    dataset_id: job.datasetId,
    attempts: Number(job.attempts),
    wait_reason: boundedDiagnostic(job.waitReason),
    last_error: boundedDiagnostic(job.lastError),
    created_at: job.createdAt,
    updated_at: job.updatedAt,
  };
}

export function orchestrationStatusApi(catalog) {
  const targets = catalog.targets({
    limit: ORCHESTRATION_TARGET_LIMIT + 1,
    newestFirst: true,
  });
  const jobs = catalog.jobs({
    limit: ORCHESTRATION_JOB_LIMIT + 1,
    activeFirst: true,
  });
  return envelope("orchestration_status", {
    schema: "uci_arena_evidence_orchestration_v1",
    limits: {
      targets: ORCHESTRATION_TARGET_LIMIT,
      jobs: ORCHESTRATION_JOB_LIMIT,
    },
    targets_truncated: targets.length > ORCHESTRATION_TARGET_LIMIT,
    jobs_truncated: jobs.length > ORCHESTRATION_JOB_LIMIT,
    targets: targets.slice(0, ORCHESTRATION_TARGET_LIMIT).map(target=>targetSummary(target,false)),
    jobs: jobs.slice(0, ORCHESTRATION_JOB_LIMIT).map(jobSummary),
  });
}

export function enqueueCampaignApi(catalog, targetId = null, options = {}) {
  if(Buffer.byteLength(JSON.stringify(options.configuration??{}))>8192)throw new Error('campaign parameters exceed 8192-byte CLI bound');
  if (targetId !== null) {
    if (!UUID_V4.test(targetId)) throw new Error("Evidence target id is malformed");
    if (!catalog.target(targetId)) throw new Error(`unknown target ${targetId}`);
  }
  const campaign=options.campaign??'time_control_curve_v1';
  const selected=targetId?catalog.target(targetId):null;
  const jobs = selected?.runtimeBinding
    ? enqueueManagedUciMeasurements(catalog,{targetId,target:selected,campaign,configuration:options.configuration??{}})
    : campaign==='time_control_curve_v1'?enqueueFirstCampaign(catalog, { targetId }):(()=>{throw new Error('Evidence campaign is incompatible');})();
  return envelope("campaign_enqueue", {
    schema: "uci_arena_evidence_campaign_enqueue_v1",
    campaign,
    target_id: targetId,
    jobs: jobs.map(jobSummary),
  });
}

export function controlJobApi(catalog, id, action) {
  if (!UUID_V4.test(id ?? "")) throw new Error("Evidence job id is malformed");
  if (!new Set(["cancel", "retry"]).has(action)) {
    throw new Error("Evidence job control action must be cancel or retry");
  }
  const job = action === "cancel" ? catalog.cancelJob(id) : catalog.retryJob(id);
  return envelope("job_control", {
    schema: "uci_arena_evidence_job_control_v1",
    action,
    job: jobSummary(job),
  });
}
