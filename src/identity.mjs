import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { runtimeRoot } from "./config.mjs";

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;

export function validModelId(value) {
  return MODEL_ID.test(String(value ?? ""));
}

function exactExistingPath(value, label, type) {
  const candidate = path.resolve(String(value ?? ""));
  let status;
  try {
    status = lstatSync(candidate);
  } catch {
    return { path: candidate, valid: false, reason: `${label} is missing: ${candidate}` };
  }
  const valid = type === "file" ? status.isFile() : status.isDirectory();
  return valid
    ? { path: candidate, valid: true, reason: "" }
    : { path: candidate, valid: false, reason: `${label} has the wrong type: ${candidate}` };
}

export function sha256File(filename) {
  const digest = createHash("sha256");
  digest.update(readFileSync(filename));
  return digest.digest("hex");
}

export function targetIdentity(target) {
  if (!validModelId(target.modelId)) {
    throw new Error("target model id is invalid");
  }
  return {
    target_id: target.id ?? null,
    label: target.label,
    model_id: target.modelId,
    model_root: path.resolve(target.modelRoot),
    model_fingerprint: String(target.modelFingerprint),
    engine_path: path.resolve(target.enginePath),
    engine_sha256: target.engineSha256,
    provider: target.provider,
    hardware_driver_fingerprint: target.hardwareDriverFingerprint || "",
    uci_options: target.uciOptions ?? {},
  };
}

export function resolveActiveTarget(config) {
  if (!existsSync(config.activeModelPointer)) {
    return { target: null, reason: "active model pointer is missing" };
  }
  let pointer;
  try {
    pointer = JSON.parse(readFileSync(config.activeModelPointer, "utf8"));
  } catch (error) {
    return { target: null, reason: `active model pointer is unreadable: ${error.message}` };
  }
  const modelId = String(pointer.model_id ?? pointer.active_model_id ?? "").trim();
  if (!validModelId(modelId)) {
    return { target: null, reason: "active model pointer model_id is invalid" };
  }
  const modelFingerprint = String(
    pointer.model_fingerprint ?? pointer.runtime_identity?.model_fingerprint ?? "",
  ).trim();
  const provider = String(
    pointer.provider
      ?? pointer.provider_effective
      ?? pointer.runtime_identity?.provider_effective
      ?? pointer.runtime_identity?.provider
      ?? "",
  ).trim();
  const pointerRoot = path.dirname(path.dirname(config.activeModelPointer));
  let modelRoot = String(pointer.model_root ?? "").trim();
  if (modelRoot) modelRoot = path.resolve(pointerRoot, modelRoot);
  if (!modelRoot && pointer.runtime_root) {
    const resolvedRuntimeRoot = path.resolve(pointerRoot, String(pointer.runtime_root));
    modelRoot = path.basename(resolvedRuntimeRoot).toLowerCase() === "current"
      ? resolvedRuntimeRoot
      : path.join(resolvedRuntimeRoot, "current");
  }
  if (!modelRoot) {
    modelRoot = path.join(config.runtimeModelsRoot, modelId, "current");
  }
  if (!modelFingerprint || !provider) {
    return {
      target: null,
      reason: "active model pointer lacks model_fingerprint or provider",
    };
  }
  const declaredEngine = String(
    pointer.engine_path ?? pointer.deployment?.engine_path ?? config.engine,
  ).trim();
  const engine = exactExistingPath(
    path.resolve(pointerRoot, declaredEngine),
    "configured engine",
    "file",
  );
  if (!engine.valid) {
    return { target: null, reason: engine.reason };
  }
  const model = exactExistingPath(modelRoot, "active model root", "directory");
  if (!model.valid) {
    return { target: null, reason: model.reason };
  }
  const engineSha256 = sha256File(engine.path);
  const declaredEngineSha256 = String(
    pointer.engine_sha256 ?? pointer.deployment?.engine_sha256 ?? "",
  ).replace(/^sha256:/i, "").toLowerCase();
  if (declaredEngineSha256 && declaredEngineSha256 !== engineSha256) {
    return { target: null, reason: "active model pointer engine SHA-256 does not match disk" };
  }
  return {
    target: {
      id: null,
      label: String(pointer.model_label ?? modelId),
      modelId,
      modelRoot: model.path,
      modelFingerprint,
      enginePath: engine.path,
      engineSha256,
      provider,
      hardwareDriverFingerprint: String(
        pointer.hardware_driver_fingerprint
          ?? pointer.runtime_identity?.hardware_driver_fingerprint
          ?? "",
      ),
      uciOptions: pointer.uci_options ?? {},
      source: "active_model_pointer",
      pointerPath: config.activeModelPointer,
    },
    reason: "",
  };
}

export function resolveJobTarget(job, catalog, config) {
  const active = job.targetId ? null : resolveActiveTarget(config);
  const target = job.targetId ? catalog.target(job.targetId) : active.target;
  if (!target) {
    return {
      target: null,
      reason: active?.reason || `explicit target ${job.targetId} is missing`,
    };
  }
  if (!validModelId(target.modelId)) {
    return { target: null, reason: "target model id is invalid" };
  }
  const engine = exactExistingPath(target.enginePath, "target engine", "file");
  if (!engine.valid) {
    return { target: null, reason: engine.reason };
  }
  const currentSha = sha256File(engine.path);
  if (currentSha !== target.engineSha256) {
    return { target: null, reason: "target engine identity drifted after enqueue" };
  }
  const model = exactExistingPath(target.modelRoot, "target model root", "directory");
  if (!model.valid) {
    return { target: null, reason: model.reason };
  }
  return {
    target: {
      ...target,
      enginePath: engine.path,
      modelRoot: model.path,
    },
    reason: "",
  };
}

export function repositoryRelative(filename) {
  return path.relative(runtimeRoot, filename).replaceAll("\\", "/");
}
