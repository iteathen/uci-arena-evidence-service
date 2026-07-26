import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sourceRepositoryRoot = path.resolve(packageRoot, "..", "..");
export const runtimeRoot = process.env.UCI_ARENA_EVIDENCE_RUNTIME_ROOT?.trim()
  ? path.resolve(process.env.UCI_ARENA_EVIDENCE_RUNTIME_ROOT)
  : sourceRepositoryRoot;
export const repositoryRoot = runtimeRoot;

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
  workspace: process.env.UCI_ARENA_EVIDENCE_ROOT || defaultWorkspace(),
  activeModelPointer: path.join(runtimeRoot, "runtime_state", "active_model_runtime.json"),
  runtimeModelsRoot: path.join(runtimeRoot, "runtime_state", "models"),
  engine: process.env.UCI_ARENA_ENGINE?.trim()
    || executable(runtimeRoot, "bin/flashfork_uci.exe", "bin/flashfork_uci"),
  stockfish: process.env.UCI_ARENA_STOCKFISH?.trim()
    || executable(runtimeRoot, "bin/stockfish.exe", "bin/stockfish"),
  referee: process.env.UCI_ARENA_REFEREE?.trim()
    || executable(
      runtimeRoot,
      "bin/flashfork_complete_game_referee.exe",
      "bin/flashfork_complete_game_referee",
    ),
  nativeHelper: path.join(
    runtimeRoot,
    "bin",
    process.platform === "win32" ? "book_forge_guard.exe" : "book_forge_guard",
  ),
  nativeLauncher: path.join(
    runtimeRoot,
    "bin",
    process.platform === "win32" ? "book_forge_launcher.exe" : "book_forge_launcher",
  ),
  gpuIsolationAttestation: process.env.UCI_ARENA_GPU_ISOLATION_ATTESTATION?.trim() || "",
  profileImports: [],
  restaurantRoots: process.env.UCI_ARENA_EVIDENCE_RUNTIME_ROOT?.trim()
    ? []
    : [path.resolve(sourceRepositoryRoot, "..", "the_restaurant")],
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
  daemon: {
    heartbeatMs: 15_000,
    cycleMs: 60_000,
    staleMs: 300_000,
  },
};

function merge(base, override) {
  const result = { ...base };
  for (const [key, value] of Object.entries(override ?? {})) {
    if (value && typeof value === "object" && !Array.isArray(value)
        && base[key] && typeof base[key] === "object" && !Array.isArray(base[key])) {
      result[key] = merge(base[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function configuredPath(value, directory) {
  if (!value) return value;
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(directory, value);
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
        (entry) => typeof entry !== "string" || !entry.trim(),
      )) {
    throw new Error("profileImports must contain at most 64 non-empty file paths");
  }
  const resources = config.resources;
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
      || resources.priorityProcessNames.some((name) => !/^[A-Za-z0-9_.-]+$/i.test(name))) {
    throw new Error("resources.priorityProcessNames must contain executable basenames");
  }
}

export async function loadConfig({ configFile, workspace } = {}) {
  assertSupportedNode();
  let loaded = {};
  let directory = packageRoot;
  if (configFile) {
    const filename = path.resolve(configFile);
    loaded = JSON.parse(await readFile(filename, "utf8"));
    directory = path.dirname(filename);
  }
  const config = merge(structuredClone(defaults), loaded);
  config.configFile = configFile ? path.resolve(configFile) : null;
  config.repositoryRoot = runtimeRoot;
  config.runtimeRoot = runtimeRoot;
  config.workspace = path.resolve(
    workspace ?? process.env.UCI_ARENA_EVIDENCE_ROOT ?? config.workspace,
  );
  for (const key of [
    "activeModelPointer",
    "runtimeModelsRoot",
    "engine",
    "stockfish",
    "referee",
    "nativeHelper",
    "nativeLauncher",
    "gpuIsolationAttestation",
  ]) {
    config[key] = configuredPath(config[key], directory);
  }
  config.restaurantRoots = [...new Set((config.restaurantRoots ?? [])
    .map((root) => configuredPath(root, directory))
    .filter((root) => existsSync(root)))];
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
  validate(config);
  return config;
}
