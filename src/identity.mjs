import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import path from "node:path";
import { runtimeRoot } from "./config.mjs";

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;
const ACTIVE_POINTER_MAX_BYTES = 64 * 1024;
const HASH_CHUNK_BYTES = 1024 * 1024;
const MAX_REASON_CHARACTERS = 512;
const MAX_DISPLAY_PATH_CHARACTERS = 320;

export function validModelId(value) {
  return MODEL_ID.test(String(value ?? ""));
}

function boundedText(value, maximum = MAX_REASON_CHARACTERS) {
  const text = String(value ?? "");
  if (text.length <= maximum) return text;
  return `${text.slice(0, Math.max(0, maximum - 3))}...`;
}

function boundedMessage(error) {
  return boundedText(error?.message ?? error ?? "unknown error");
}

function displayedPath(value) {
  return boundedText(value, MAX_DISPLAY_PATH_CHARACTERS);
}

function resolveCandidate(value, label) {
  try {
    return { path: path.resolve(String(value ?? "")), reason: "" };
  } catch (error) {
    return {
      path: "",
      reason: boundedText(`${label} path is invalid: ${boundedMessage(error)}`),
    };
  }
}

function inspectExactPath(value, label) {
  const resolved = resolveCandidate(value, label);
  if (resolved.reason) return { path: "", status: null, reason: resolved.reason };

  try {
    return { path: resolved.path, status: lstatSync(resolved.path), reason: "" };
  } catch (error) {
    const description = error?.code === "ENOENT"
      ? `${label} is missing: ${displayedPath(resolved.path)}`
      : `${label} cannot be inspected: ${boundedMessage(error)}`;
    return { path: resolved.path, status: null, reason: boundedText(description) };
  }
}

function pathStillNamesOpenedFile(filename, openedStatus) {
  try {
    const current = lstatSync(filename);
    return !current.isSymbolicLink()
      && current.isFile()
      && current.dev === openedStatus.dev
      && current.ino === openedStatus.ino;
  } catch {
    return false;
  }
}

function exactExistingDirectory(value, label) {
  const inspected = inspectExactPath(value, label);
  if (!inspected.status) {
    return { path: inspected.path, valid: false, reason: inspected.reason };
  }
  if (inspected.status.isSymbolicLink()) {
    return {
      path: inspected.path,
      valid: false,
      reason: boundedText(
        `${label} must not be a symbolic link: ${displayedPath(inspected.path)}`,
      ),
    };
  }
  if (!inspected.status.isDirectory()) {
    return {
      path: inspected.path,
      valid: false,
      reason: boundedText(`${label} has the wrong type: ${displayedPath(inspected.path)}`),
    };
  }
  return { path: inspected.path, valid: true, reason: "" };
}

function readStableBoundedText(descriptor, expectedSize) {
  const buffer = Buffer.alloc(expectedSize + 1);
  let total = 0;
  while (total < buffer.length) {
    const count = readSync(
      descriptor,
      buffer,
      total,
      buffer.length - total,
      total,
    );
    if (count === 0) break;
    total += count;
  }
  if (total !== expectedSize) {
    return { text: null, reason: "active model pointer changed size during admission" };
  }
  return { text: buffer.subarray(0, total).toString("utf8"), reason: "" };
}

function readActivePointer(filename) {
  const inspected = inspectExactPath(filename, "active model pointer");
  if (!inspected.status) {
    const reason = inspected.reason.startsWith("active model pointer is missing:")
      ? "active model pointer is missing"
      : inspected.reason;
    return { pointer: null, reason };
  }
  if (inspected.status.isSymbolicLink() || !inspected.status.isFile()) {
    return {
      pointer: null,
      reason: "active model pointer must be an exact regular non-symlink file",
    };
  }
  if (!Number.isSafeInteger(inspected.status.size)
      || inspected.status.size < 0
      || inspected.status.size > ACTIVE_POINTER_MAX_BYTES) {
    return {
      pointer: null,
      reason: `active model pointer exceeds ${ACTIVE_POINTER_MAX_BYTES} bytes`,
    };
  }

  let descriptor;
  let text = null;
  let failure = "";
  try {
    const noFollow = process.platform === "linux" && Number.isInteger(constants.O_NOFOLLOW)
      ? constants.O_NOFOLLOW
      : 0;
    descriptor = openSync(inspected.path, constants.O_RDONLY | noFollow);
    const openedStatus = fstatSync(descriptor);
    if (!openedStatus.isFile()) {
      failure = "active model pointer changed to a non-file during admission";
    } else if (!Number.isSafeInteger(openedStatus.size)
        || openedStatus.size < 0
        || openedStatus.size > ACTIVE_POINTER_MAX_BYTES) {
      failure = `active model pointer exceeds ${ACTIVE_POINTER_MAX_BYTES} bytes`;
    } else if (openedStatus.dev !== inspected.status.dev
        || openedStatus.ino !== inspected.status.ino
        || !pathStillNamesOpenedFile(inspected.path, openedStatus)) {
      failure = "active model pointer changed identity during admission";
    } else {
      const read = readStableBoundedText(descriptor, openedStatus.size);
      text = read.text;
      failure = read.reason;
      if (!failure) {
        const finalStatus = fstatSync(descriptor);
        if (finalStatus.size !== openedStatus.size
            || finalStatus.mtimeMs !== openedStatus.mtimeMs
            || finalStatus.ctimeMs !== openedStatus.ctimeMs) {
          failure = "active model pointer changed during admission";
        } else if (!pathStillNamesOpenedFile(inspected.path, openedStatus)) {
          failure = "active model pointer path changed during admission";
        }
      }
    }
  } catch (error) {
    failure = boundedText(`active model pointer is unreadable: ${boundedMessage(error)}`);
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch (error) {
        if (!failure) {
          failure = boundedText(
            `active model pointer descriptor cannot be closed: ${boundedMessage(error)}`,
          );
        }
      }
    }
  }
  if (failure) return { pointer: null, reason: failure };

  let pointer;
  try {
    pointer = JSON.parse(text);
  } catch (error) {
    return {
      pointer: null,
      reason: boundedText(
        `active model pointer contains invalid JSON: ${boundedMessage(error)}`,
      ),
    };
  }
  if (pointer === null || Array.isArray(pointer) || typeof pointer !== "object") {
    return {
      pointer: null,
      reason: "active model pointer must contain one JSON object",
    };
  }
  return { pointer, reason: "" };
}

function hashExactRegularFile(value, label) {
  const inspected = inspectExactPath(value, label);
  if (!inspected.status) {
    return { path: inspected.path, sha256: "", valid: false, reason: inspected.reason };
  }
  if (inspected.status.isSymbolicLink()) {
    return {
      path: inspected.path,
      sha256: "",
      valid: false,
      reason: boundedText(
        `${label} must not be a symbolic link: ${displayedPath(inspected.path)}`,
      ),
    };
  }
  if (!inspected.status.isFile()) {
    return {
      path: inspected.path,
      sha256: "",
      valid: false,
      reason: boundedText(`${label} has the wrong type: ${displayedPath(inspected.path)}`),
    };
  }
  if (!Number.isSafeInteger(inspected.status.size) || inspected.status.size < 0) {
    return {
      path: inspected.path,
      sha256: "",
      valid: false,
      reason: `${label} size cannot be represented safely`,
    };
  }

  let descriptor;
  let digest = "";
  let failure = "";
  try {
    const noFollow = process.platform === "linux" && Number.isInteger(constants.O_NOFOLLOW)
      ? constants.O_NOFOLLOW
      : 0;
    descriptor = openSync(inspected.path, constants.O_RDONLY | noFollow);
    const openedStatus = fstatSync(descriptor);
    if (!openedStatus.isFile()) {
      failure = `${label} changed to a non-file during identity hashing`;
    } else if (!Number.isSafeInteger(openedStatus.size) || openedStatus.size < 0) {
      failure = `${label} size cannot be represented safely`;
    } else if (openedStatus.dev !== inspected.status.dev
        || openedStatus.ino !== inspected.status.ino
        || !pathStillNamesOpenedFile(inspected.path, openedStatus)) {
      failure = `${label} changed identity before hashing`;
    } else {
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
      let offset = 0;
      while (!failure && offset < openedStatus.size) {
        const requested = Math.min(buffer.length, openedStatus.size - offset);
        const count = readSync(descriptor, buffer, 0, requested, offset);
        if (count === 0) {
          failure = `${label} changed size during hashing`;
          break;
        }
        hash.update(buffer.subarray(0, count));
        offset += count;
      }
      if (!failure) {
        const extra = readSync(descriptor, buffer, 0, 1, offset);
        if (extra !== 0) failure = `${label} changed size during hashing`;
      }
      const finalStatus = fstatSync(descriptor);
      if (!failure && (
        finalStatus.size !== openedStatus.size
        || finalStatus.mtimeMs !== openedStatus.mtimeMs
        || finalStatus.ctimeMs !== openedStatus.ctimeMs
        || !pathStillNamesOpenedFile(inspected.path, openedStatus)
      )) {
        failure = `${label} changed during hashing`;
      }
      if (!failure) digest = hash.digest("hex");
    }
  } catch (error) {
    failure = boundedText(`${label} cannot be hashed: ${boundedMessage(error)}`);
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch (error) {
        if (!failure) {
          failure = boundedText(`${label} descriptor cannot be closed: ${boundedMessage(error)}`);
        }
      }
    }
  }
  return failure
    ? { path: inspected.path, sha256: "", valid: false, reason: boundedText(failure) }
    : { path: inspected.path, sha256: digest, valid: true, reason: "" };
}

export function sha256File(filename) {
  const identity = hashExactRegularFile(filename, "file");
  if (!identity.valid) throw new Error(identity.reason);
  return identity.sha256;
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
  const admittedPointer = readActivePointer(config.activeModelPointer);
  if (!admittedPointer.pointer) {
    return { target: null, reason: admittedPointer.reason };
  }
  const pointer = admittedPointer.pointer;
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
  const engine = hashExactRegularFile(
    path.resolve(pointerRoot, declaredEngine),
    "configured engine",
  );
  if (!engine.valid) {
    return { target: null, reason: engine.reason };
  }
  const model = exactExistingDirectory(modelRoot, "active model root");
  if (!model.valid) {
    return { target: null, reason: model.reason };
  }
  const declaredEngineSha256 = String(
    pointer.engine_sha256 ?? pointer.deployment?.engine_sha256 ?? "",
  ).replace(/^sha256:/i, "").toLowerCase();
  if (declaredEngineSha256 && declaredEngineSha256 !== engine.sha256) {
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
      engineSha256: engine.sha256,
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
  const engine = hashExactRegularFile(target.enginePath, "target engine");
  if (!engine.valid) {
    return { target: null, reason: engine.reason };
  }
  if (engine.sha256 !== target.engineSha256) {
    return { target: null, reason: "target engine identity drifted after enqueue" };
  }
  const model = exactExistingDirectory(target.modelRoot, "target model root");
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
