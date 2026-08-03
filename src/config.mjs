import { constants, existsSync, lstatSync } from "node:fs";
import { open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalDaemonTiming,
  validateDaemonTiming,
} from "./daemon_timing.mjs";

const MAX_CONFIG_FILE_BYTES = 1024 * 1024;
const MAX_CONFIGURED_PATH_CHARACTERS = 32_767;
const MAX_CONFIG_ERROR_CHARACTERS = 512;
const MAX_CONFIG_DISPLAY_PATH_CHARACTERS = 320;
const MAX_CONFIG_NESTING_DEPTH = 64;
const MAX_CONFIG_VISITED_VALUES = 10_000;
const FORBIDDEN_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const defaultRuntimeRoot = process.env.UCI_ARENA_EVIDENCE_RUNTIME_ROOT?.trim()
  ? path.resolve(process.env.UCI_ARENA_EVIDENCE_RUNTIME_ROOT)
  : packageRoot;
export const runtimeRoot = defaultRuntimeRoot;
export const repositoryRoot = runtimeRoot;

function boundedText(value, maximum = MAX_CONFIG_ERROR_CHARACTERS) {
  const text = String(value ?? "");
  if (text.length <= maximum) return text;
  return `${text.slice(0, Math.max(0, maximum - 3))}...`;
}

function boundedMessage(error) {
  return boundedText(error?.message ?? error ?? "unknown error");
}

function displayedPath(value) {
  return boundedText(value, MAX_CONFIG_DISPLAY_PATH_CHARACTERS);
}

function defaultWorkspace() {
  if (process.platform === "win32") return "E:/uci-arena-evidence";
  const stateRoot = process.env.XDG_STATE_HOME?.trim()
    || path.join(os.homedir(), ".local", "state");
  return path.join(stateRoot, "uci-arena-evidence");
}

function executable(root, windowsName, unixName) {
  return path.join(root, process.platform === "win32" ? windowsName : unixName);
}

const defaults = {
  schema: "uci_arena_evidence_service_config_v1",
  runtimeRoot: defaultRuntimeRoot,
  workspace: process.env.UCI_ARENA_EVIDENCE_ROOT || defaultWorkspace(),
  activeModelPointer: path.join(runtimeRoot, "runtime_state", "active_model_runtime.json"),
  runtimeModelsRoot: path.join(runtimeRoot, "runtime_state", "models"),
  engine: process.env.UCI_ARENA_ENGINE?.trim()
    || executable(runtimeRoot, "bin/uci_arena_engine.exe", "bin/uci_arena_engine"),
  stockfish: process.env.UCI_ARENA_STOCKFISH?.trim()
    || executable(runtimeRoot, "bin/stockfish.exe", "bin/stockfish"),
  referee: process.env.UCI_ARENA_REFEREE?.trim()
    || executable(
      runtimeRoot,
      "bin/uci_arena_complete_game_referee.exe",
      "bin/uci_arena_complete_game_referee",
    ),
  nativeHelper: path.join(
    packageRoot,
    "native",
    "bin",
    process.platform === "win32"
      ? "uci_arena_background_guard.exe"
      : "uci_arena_background_guard",
  ),
  nativeLauncher: path.join(
    packageRoot,
    "native",
    "bin",
    process.platform === "win32"
      ? "uci_arena_service_launcher.exe"
      : "uci_arena_service_launcher",
  ),
  gpuIsolationAttestation: process.env.UCI_ARENA_GPU_ISOLATION_ATTESTATION?.trim() || "",
  profileImports: [],
  externalOwnerRoots: [],
  resources: {
    minimumFreeWorkspaceGb: 75,
    pauseAvailableMemoryGb: 6,
    maximumUsedMemoryPercent: 70,
    maximumUsedCpuPercent: 20,
    maximumGpuUtilPercent: 5,
    inputIdleMs: 60_000,
    consecutiveIdleSamples: 3,
    pollMs: 1_000,
    revokeWithinMs: 2_000,
    priorityProcessNames: process.platform === "win32"
      ? ["msbuild.exe", "cl.exe"]
      : ["ninja", "cmake", "make", "cc1plus"],
  },
  daemon: canonicalDaemonTiming(),
};

function assertSafeConfigValue(root) {
  const pending = [{ value: root, depth: 0 }];
  let visited = 0;
  while (pending.length > 0) {
    const { value, depth } = pending.pop();
    visited += 1;
    if (visited > MAX_CONFIG_VISITED_VALUES) {
      throw new Error(`configuration exceeds ${MAX_CONFIG_VISITED_VALUES} values`);
    }
    if (depth > MAX_CONFIG_NESTING_DEPTH) {
      throw new Error(`configuration exceeds nesting depth ${MAX_CONFIG_NESTING_DEPTH}`);
    }
    if (Array.isArray(value)) {
      for (const nested of value) pending.push({ value: nested, depth: depth + 1 });
      continue;
    }
    if (value === null || typeof value !== "object") continue;
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new Error("configuration must contain plain JSON objects");
    }
    for (const [key, nested] of Object.entries(value)) {
      if (FORBIDDEN_OBJECT_KEYS.has(key)) {
        throw new Error(`configuration contains forbidden object key ${boundedText(key, 64)}`);
      }
      pending.push({ value: nested, depth: depth + 1 });
    }
  }
}

function assertConfigDocument(value) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error("configuration file must contain one JSON object");
  }
  assertSafeConfigValue(value);
}

function merge(base, override) {
  const result = { ...base };
  for (const [key, value] of Object.entries(override ?? {})) {
    if (FORBIDDEN_OBJECT_KEYS.has(key)) {
      throw new Error(`configuration contains forbidden object key ${boundedText(key, 64)}`);
    }
    if (value && typeof value === "object" && !Array.isArray(value)
        && base[key] && typeof base[key] === "object" && !Array.isArray(base[key])) {
      result[key] = merge(base[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function requirePathString(value, label, allowEmpty = false) {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) {
    throw new Error(`${label} must be ${allowEmpty ? "a string" : "a non-empty path string"}`);
  }
  if (value.length > MAX_CONFIGURED_PATH_CHARACTERS) {
    throw new Error(`${label} exceeds ${MAX_CONFIGURED_PATH_CHARACTERS} characters`);
  }
  return value;
}

function configuredPath(value, directory) {
  if (!value) return value;
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(directory, value);
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

async function readConfigText(configFile) {
  const filename = path.resolve(requirePathString(configFile, "configFile"));
  let initialStatus;
  try {
    initialStatus = lstatSync(filename);
  } catch (error) {
    throw new Error(boundedText(`configuration file cannot be inspected: ${boundedMessage(error)}`));
  }
  if (initialStatus.isSymbolicLink() || !initialStatus.isFile()) {
    throw new Error("configuration file must be an exact regular non-symlink file");
  }
  if (!Number.isSafeInteger(initialStatus.size)
      || initialStatus.size < 0
      || initialStatus.size > MAX_CONFIG_FILE_BYTES) {
    throw new Error(`configuration file exceeds ${MAX_CONFIG_FILE_BYTES} bytes`);
  }

  let handle;
  let text = null;
  let failure = "";
  try {
    const noFollow = process.platform === "linux" && Number.isInteger(constants.O_NOFOLLOW)
      ? constants.O_NOFOLLOW
      : 0;
    handle = await open(filename, constants.O_RDONLY | noFollow);
    const openedStatus = await handle.stat();
    if (!openedStatus.isFile()) {
      failure = "configuration file changed to a non-file during admission";
    } else if (!Number.isSafeInteger(openedStatus.size)
        || openedStatus.size < 0
        || openedStatus.size > MAX_CONFIG_FILE_BYTES) {
      failure = `configuration file exceeds ${MAX_CONFIG_FILE_BYTES} bytes`;
    } else if (openedStatus.dev !== initialStatus.dev
        || openedStatus.ino !== initialStatus.ino
        || !pathStillNamesOpenedFile(filename, openedStatus)) {
      failure = "configuration file changed identity during admission";
    } else {
      const buffer = Buffer.alloc(openedStatus.size + 1);
      let total = 0;
      while (total < buffer.length) {
        const { bytesRead } = await handle.read(
          buffer,
          total,
          buffer.length - total,
          total,
        );
        if (bytesRead === 0) break;
        total += bytesRead;
      }
      if (total !== openedStatus.size) {
        failure = "configuration file changed size during admission";
      } else if (!pathStillNamesOpenedFile(filename, openedStatus)) {
        failure = "configuration file path changed during admission";
      } else {
        const finalStatus = await handle.stat();
        if (finalStatus.size !== openedStatus.size
            || finalStatus.mtimeMs !== openedStatus.mtimeMs
            || finalStatus.ctimeMs !== openedStatus.ctimeMs) {
          failure = "configuration file changed during admission";
        } else {
          text = buffer.subarray(0, total).toString("utf8");
        }
      }
    }
  } catch (error) {
    failure = boundedText(`configuration file is unreadable: ${boundedMessage(error)}`);
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch (error) {
        if (!failure) {
          failure = boundedText(`configuration file cannot be closed: ${boundedMessage(error)}`);
        }
      }
    }
  }
  if (failure) throw new Error(failure);
  return { filename, text };
}

function validateOwnerRoots(value) {
  if (!Array.isArray(value)
      || value.length > 64
      || value.some((entry) => typeof entry !== "string"
        || !entry.trim()
        || entry.length > MAX_CONFIGURED_PATH_CHARACTERS)) {
    throw new Error(
      "externalOwnerRoots must contain at most 64 non-empty paths of at most 32767 characters",
    );
  }
  return value;
}

function configuredExternalOwnerRoots(loaded, fallback) {
  const canonical = loaded.externalOwnerRoots;
  const legacy = loaded.restaurantRoots;
  if (canonical !== undefined && legacy !== undefined) {
    throw new Error("configure only externalOwnerRoots; the legacy owner-root key cannot be combined with it");
  }
  return validateOwnerRoots(canonical ?? legacy ?? fallback);
}

function admittedExternalOwnerRoots(values, directory) {
  const roots = [];
  const seen = new Set();
  for (const value of values) {
    const candidate = configuredPath(value, directory);
    if (seen.has(candidate)) continue;

    let status;
    try {
      status = lstatSync(candidate);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw new Error(boundedText(
        `cannot inspect external owner root ${displayedPath(candidate)}: ${error?.message ?? error}`,
      ));
    }
    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw new Error(boundedText(
        `external owner root must be an exact regular non-symlink directory: ${displayedPath(candidate)}`,
      ));
    }
    seen.add(candidate);
    roots.push(candidate);
  }
  return roots;
}

export function assertSupportedNode() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 24 || (major === 24 && minor < 15)) {
    throw new Error(`Arena Evidence Service requires Node.js >=24.15.0; found ${process.versions.node}`);
  }
}

function validate(config) {
  if (config.schema !== defaults.schema) throw new Error(`unsupported config schema ${config.schema}`);
  if (!Array.isArray(config.profileImports)
      || config.profileImports.length > 64
      || config.profileImports.some(
        (entry) => typeof entry !== "string"
          || !entry.trim()
          || entry.length > MAX_CONFIGURED_PATH_CHARACTERS,
      )) {
    throw new Error(
      "profileImports must contain at most 64 non-empty paths of at most 32767 characters",
    );
  }
  validateOwnerRoots(config.externalOwnerRoots);
  validateDaemonTiming(config.daemon);
  const resources = config.resources;
  if (!resources || typeof resources !== "object" || Array.isArray(resources)) {
    throw new Error("resources must be an object");
  }
  const numbers = [
    ["minimumFreeWorkspaceGb", resources.minimumFreeWorkspaceGb, 1, 100_000],
    ["pauseAvailableMemoryGb", resources.pauseAvailableMemoryGb, 1, 10_000],
    ["maximumUsedMemoryPercent", resources.maximumUsedMemoryPercent, 1, 99],
    ["maximumUsedCpuPercent", resources.maximumUsedCpuPercent, 0, 99],
    ["maximumGpuUtilPercent", resources.maximumGpuUtilPercent, 0, 100],
    ["inputIdleMs", resources.inputIdleMs, 0, 86_400_000],
    ["consecutiveIdleSamples", resources.consecutiveIdleSamples, 1, 100],
    ["pollMs", resources.pollMs, 100, 2_000],
    ["revokeWithinMs", resources.revokeWithinMs, 250, 2_000],
  ];
  for (const [name, value, minimum, maximum] of numbers) {
    if (!Number.isFinite(value) || value < minimum || value > maximum) {
      throw new Error(`resources.${name} must be in ${minimum}..${maximum}`);
    }
  }
  if (!Array.isArray(resources.priorityProcessNames)
      || resources.priorityProcessNames.some((name) =>
        typeof name !== "string" || !/^[A-Za-z0-9_.-]+$/i.test(name))) {
    throw new Error("resources.priorityProcessNames must contain executable basenames");
  }
}

export async function loadConfig({ configFile, workspace } = {}) {
  assertSupportedNode();
  let loaded = {};
  let directory = packageRoot;
  let configFilename = null;
  if (configFile) {
    const admitted = await readConfigText(configFile);
    configFilename = admitted.filename;
    try {
      loaded = JSON.parse(admitted.text);
    } catch (error) {
      throw new Error(boundedText(`configuration file contains invalid JSON: ${boundedMessage(error)}`));
    }
    assertConfigDocument(loaded);
    directory = path.dirname(configFilename);
  }
  const ownerRoots = configuredExternalOwnerRoots(loaded, defaults.externalOwnerRoots);
  const config = merge(structuredClone(defaults), loaded);
  delete config.restaurantRoots;
  validate(config);
  config.configFile = configFilename;
  const environmentRuntimeRoot = process.env.UCI_ARENA_EVIDENCE_RUNTIME_ROOT?.trim();
  const selectedRuntimeRoot = environmentRuntimeRoot || config.runtimeRoot;
  config.runtimeRoot = configuredPath(
    requirePathString(selectedRuntimeRoot, "runtimeRoot"),
    directory,
  );
  config.repositoryRoot = config.runtimeRoot;
  const selectedWorkspace = workspace ?? process.env.UCI_ARENA_EVIDENCE_ROOT ?? config.workspace;
  config.workspace = path.resolve(requirePathString(selectedWorkspace, "workspace"));
  for (const key of [
    "activeModelPointer",
    "runtimeModelsRoot",
    "engine",
    "stockfish",
    "referee",
    "nativeHelper",
    "nativeLauncher",
  ]) {
    config[key] = configuredPath(requirePathString(config[key], key), directory);
  }
  config.gpuIsolationAttestation = configuredPath(
    requirePathString(config.gpuIsolationAttestation, "gpuIsolationAttestation", true),
    directory,
  );
  config.externalOwnerRoots = admittedExternalOwnerRoots(ownerRoots, directory);
  Object.defineProperty(config, "restaurantRoots", {
    configurable: false,
    enumerable: false,
    value: config.externalOwnerRoots,
    writable: false,
  });
  config.profileImports = [...new Set(
    config.profileImports.map((profile) => configuredPath(profile, directory)),
  )];
  config.paths = {
    catalog: path.join(config.workspace, "catalog.sqlite"),
    artifacts: path.join(config.workspace, "artifacts"),
    attempts: path.join(config.workspace, "attempts"),
    exports: path.join(config.workspace, "exports"),
    locks: path.join(config.workspace, "locks"),
    profiles: path.join(config.workspace, "profiles"),
  };
  config.daemonHeartbeatFile = path.join(config.paths.locks, "daemon.heartbeat.json");
  config.nativeHelperAvailable = process.platform === "win32"
    && existsSync(config.nativeHelper);
  config.nativeLauncherAvailable = process.platform === "win32"
    && existsSync(config.nativeLauncher);
  return config;
}
