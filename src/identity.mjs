import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { repositoryRoot } from "./config.mjs";

export function sha256File(filename) {
  const digest = createHash("sha256");
  digest.update(readFileSync(filename));
  return digest.digest("hex");
}

export function targetIdentity(target) {
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
    const runtimeRoot = path.resolve(pointerRoot, String(pointer.runtime_root));
    modelRoot = path.basename(runtimeRoot).toLowerCase() === "current"
      ? runtimeRoot
      : path.join(runtimeRoot, "current");
  }
  if (!modelRoot && modelId) {
    modelRoot = path.join(config.runtimeModelsRoot, modelId, "current");
  }
  if (!modelId || !modelFingerprint || !provider || !modelRoot) {
    return {
      target: null,
      reason: "active model pointer lacks model_id, model_fingerprint, provider, or model root",
    };
  }
  const declaredEngine = String(
    pointer.engine_path ?? pointer.deployment?.engine_path ?? config.engine,
  ).trim();
  const enginePath = path.resolve(pointerRoot, declaredEngine);
  if (!existsSync(enginePath) || !statSync(enginePath).isFile()) {
    return { target: null, reason: `configured engine is missing: ${enginePath}` };
  }
  if (!existsSync(modelRoot)) {
    return { target: null, reason: `active model root is missing: ${modelRoot}` };
  }
  const engineSha256 = sha256File(enginePath);
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
      modelRoot,
      modelFingerprint,
      enginePath,
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
  const target = job.targetId ? catalog.target(job.targetId) : resolveActiveTarget(config).target;
  if (!target) {
    const active = resolveActiveTarget(config);
    return { target: null, reason: active.reason || `explicit target ${job.targetId} is missing` };
  }
  if (!existsSync(target.enginePath)) {
    return { target: null, reason: `target engine is missing: ${target.enginePath}` };
  }
  const currentSha = sha256File(target.enginePath);
  if (currentSha !== target.engineSha256) {
    return { target: null, reason: "target engine identity drifted after enqueue" };
  }
  if (!existsSync(target.modelRoot)) {
    return { target: null, reason: `target model root is missing: ${target.modelRoot}` };
  }
  return { target, reason: "" };
}

export function repositoryRelative(filename) {
  return path.relative(repositoryRoot, filename).replaceAll("\\", "/");
}
