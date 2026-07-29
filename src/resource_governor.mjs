import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { readFile, readdir, statfs } from "node:fs/promises";
import { promisify } from "node:util";
import {
  foregroundResourceDemand,
} from "@uci-arena/background-service-runtime/lease";
import {
  restaurantOwnerObservation,
} from "@uci-arena/background-service-runtime/resource-isolation";
import { NativeResourceHelper } from "@uci-arena/background-service-runtime/native-resource-helper";

const execFileAsync = promisify(execFile);
const gibibyte = 1024 ** 3;

function cpuTotals() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    idle += cpu.times.idle;
    total += Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
  }
  return { idle, total };
}

async function processNames(names) {
  if (names.length === 0) return [];
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync(
        "tasklist.exe",
        ["/FO", "CSV", "/NH"],
        { windowsHide: true, timeout: 1_500, maxBuffer: 4 * 1024 * 1024 },
      );
      const lower = stdout.toLowerCase();
      return names.filter((name) => lower.includes(`"${name.toLowerCase()}"`));
    }
    const { stdout } = await execFileAsync(
      "ps",
      ["-eo", "comm="],
      { timeout: 1_500, maxBuffer: 4 * 1024 * 1024 },
    );
    const running = new Set(stdout.split(/\r?\n/).map((name) => path.basename(name.trim()).toLowerCase()));
    return names.filter((name) => running.has(path.basename(name).toLowerCase()));
  } catch {
    return [];
  }
}

async function gpuSample() {
  try {
    const { stdout } = await execFileAsync(
      process.platform === "win32" ? "nvidia-smi.exe" : "nvidia-smi",
      [
        "--query-gpu=uuid,utilization.gpu,memory.used,memory.total",
        "--format=csv,noheader,nounits",
      ],
      { windowsHide: true, timeout: 2_000, maxBuffer: 1024 * 1024 },
    );
    const rows = stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => {
      const [uuid, utilization, used, total] = line.split(",").map((value) => value.trim());
      return {
        uuid,
        utilizationPercent: Number(utilization),
        memoryUsedMb: Number(used),
        memoryTotalMb: Number(total),
      };
    });
    if (rows.length !== 1 || rows.some((row) => (
      !row.uuid || !Number.isFinite(row.utilizationPercent)
      || !Number.isFinite(row.memoryUsedMb) || !Number.isFinite(row.memoryTotalMb)
    ))) {
      return { available: false, reason: "single_gpu_telemetry_unavailable", rows };
    }
    return { available: true, ...rows[0] };
  } catch (error) {
    return { available: false, reason: `nvidia_smi_unavailable:${error?.code ?? error?.message ?? error}` };
  }
}

async function linuxPlatformProbe() {
  if (process.platform !== "linux") return null;
  let inputIdleMs = null;
  try {
    const { stdout } = await execFileAsync(
      "loginctl",
      ["show-user", os.userInfo().username, "-p", "IdleHint", "-p", "IdleSinceHintMonotonic"],
      { timeout: 1_000, maxBuffer: 16 * 1024 },
    );
    const fields = Object.fromEntries(stdout.trim().split(/\r?\n/).map((line) => {
      const index = line.indexOf("=");
      return index > 0 ? [line.slice(0, index), line.slice(index + 1)] : [line, ""];
    }));
    if (fields.IdleHint === "no") inputIdleMs = 0;
    else if (fields.IdleHint === "yes") {
      const sinceUs = Number(fields.IdleSinceHintMonotonic);
      inputIdleMs = Number.isFinite(sinceUs)
        ? Math.max(0, os.uptime() * 1_000 - sinceUs / 1_000)
        : Number.MAX_SAFE_INTEGER;
    }
  } catch {}
  let onBattery = false;
  try {
    for (const entry of await readdir("/sys/class/power_supply", { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const root = path.join("/sys/class/power_supply", entry.name);
      const type = (await readFile(path.join(root, "type"), "utf8")).trim().toLowerCase();
      if (type !== "battery") continue;
      const status = (await readFile(path.join(root, "status"), "utf8")).trim().toLowerCase();
      if (status === "discharging") onBattery = true;
    }
  } catch {}
  let thermalPressure = false;
  try {
    for (const entry of await readdir("/sys/class/thermal", { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith("thermal_zone")) continue;
      const root = path.join("/sys/class/thermal", entry.name);
      const temperature = Number((await readFile(path.join(root, "temp"), "utf8")).trim());
      let critical = 100_000;
      try {
        const tripEntries = await readdir(root, { withFileTypes: true });
        for (const trip of tripEntries) {
          const match = /^trip_point_(\d+)_type$/.exec(trip.name);
          if (!match) continue;
          const type = (await readFile(path.join(root, trip.name), "utf8")).trim().toLowerCase();
          if (type !== "critical" && type !== "hot") continue;
          const threshold = Number(
            (await readFile(path.join(root, `trip_point_${match[1]}_temp`), "utf8")).trim(),
          );
          if (Number.isFinite(threshold)) critical = Math.min(critical, threshold);
        }
      } catch {}
      if (Number.isFinite(temperature) && temperature >= critical * 0.9) thermalPressure = true;
    }
  } catch {}
  return {
    schema: "uci_arena_linux_resource_probe_v1",
    input_idle_ms: inputIdleMs,
    on_battery: onBattery,
    battery_saver: false,
    processor_limit_percent: null,
    thermal_pressure: thermalPressure,
  };
}

export class ResourceGovernor {
  constructor(config, catalog, {
    cpuTotalsImpl = cpuTotals,
    statfsImpl = statfs,
    freeMemoryImpl = () => os.freemem(),
    totalMemoryImpl = () => os.totalmem(),
    processProbe = processNames,
    gpuProbe = gpuSample,
    ownerProbe = restaurantOwnerObservation,
    foregroundProbe = foregroundResourceDemand,
    nativeHelper = new NativeResourceHelper(config),
    platformProbe = linuxPlatformProbe,
  } = {}) {
    this.config = config;
    this.catalog = catalog;
    this.cpuTotals = cpuTotalsImpl;
    this.statfs = statfsImpl;
    this.freeMemory = freeMemoryImpl;
    this.totalMemory = totalMemoryImpl;
    this.processProbe = processProbe;
    this.gpuProbe = gpuProbe;
    this.ownerProbe = ownerProbe;
    this.foregroundProbe = foregroundProbe;
    this.native = nativeHelper;
    this.platformProbe = platformProbe;
    this.previousCpu = this.cpuTotals();
    this.idleSamples = 0;
    this.last = {
      allowed: false,
      mode: "waiting",
      reason: "resource permit not sampled",
      sampledAt: new Date().toISOString(),
    };
    this.native.start?.();
    try {
      os.setPriority(process.pid, os.constants.priority.PRIORITY_LOW);
    } catch {}
  }

  async permit({
    provider = "auto",
    enginePath = this.config.engine,
    ownedEngineRunning = false,
    duringRun = false,
  } = {}) {
    const resources = this.config.resources;
    const nowCpu = this.cpuTotals();
    const idleDelta = nowCpu.idle - this.previousCpu.idle;
    const totalDelta = nowCpu.total - this.previousCpu.total;
    this.previousCpu = nowCpu;
    const cpuUsedPercent = totalDelta > 0 ? (1 - idleDelta / totalDelta) * 100 : 100;
    const disk = await this.statfs(this.config.workspace, { bigint: true });
    const freeWorkspaceGb = Number(disk.bavail * disk.bsize) / gibibyte;
    const availableMemoryGb = this.freeMemory() / gibibyte;
    const usedMemoryPercent = (1 - this.freeMemory() / this.totalMemory()) * 100;
    const engineProcessNames = [...new Set([
      path.basename(enginePath),
      path.basename(this.config.engine),
      path.basename(this.config.stockfish),
      path.basename(this.config.referee),
    ].filter(Boolean))];
    const [nativeResult, portableResult, gpu, runningProcesses] = await Promise.all([
      this.native.probe(),
      this.platformProbe(),
      this.gpuProbe(),
      this.processProbe([...resources.priorityProcessNames, ...engineProcessNames]),
    ]);
    const native = nativeResult ?? portableResult;
    const ownerObservations = this.config.restaurantRoots.map((root) => this.ownerProbe(root));
    const restaurantOwnerActive = ownerObservations.some((observation) => observation.active);
    const foregroundDemand = this.foregroundProbe();
    const configuredProcesses = runningProcesses.filter(
      (name) => !engineProcessNames.some(
        (engineName) => path.basename(name).toLowerCase() === engineName.toLowerCase(),
      ),
    );
    const unownedEngines = ownedEngineRunning ? [] : runningProcesses.filter(
      (name) => engineProcessNames.some(
        (engineName) => path.basename(name).toLowerCase() === engineName.toLowerCase(),
      ),
    );
    let allowed = true;
    let mode = "sampling";
    let reason = "";
    if (this.catalog.control().paused) {
      allowed = false;
      mode = "paused";
      reason = this.catalog.control().reason || "operator pause";
    } else if (foregroundDemand) {
      allowed = false;
      mode = "preempt";
      reason = "foreground resource request is waiting";
    } else if (restaurantOwnerActive) {
      allowed = false;
      mode = "preempt";
      reason = "Restaurant resource owner is active";
    } else if (unownedEngines.length > 0) {
      allowed = false;
      mode = "preempt";
      reason = `unowned engine process is running: ${unownedEngines.join(", ")}`;
    } else if (configuredProcesses.length > 0) {
      allowed = false;
      mode = "backoff";
      reason = `priority process is running: ${configuredProcesses.join(", ")}`;
    } else if (freeWorkspaceGb < resources.minimumFreeWorkspaceGb) {
      allowed = false;
      mode = "backoff";
      reason = `workspace free space ${freeWorkspaceGb.toFixed(1)} GiB`;
    } else if (availableMemoryGb < resources.pauseAvailableMemoryGb
        || usedMemoryPercent > resources.maximumUsedMemoryPercent) {
      allowed = false;
      mode = "backoff";
      reason = `memory pressure ${availableMemoryGb.toFixed(1)} GiB free, ${usedMemoryPercent.toFixed(1)}% used`;
    } else if (!native || native.input_idle_ms === null
        || native.input_idle_ms === undefined
        || !Number.isFinite(Number(native.input_idle_ms))) {
      allowed = false;
      mode = "backoff";
      reason = "platform idle and power telemetry is unavailable";
    } else if (native?.on_battery || native?.battery_saver) {
      allowed = false;
      mode = "backoff";
      reason = native.battery_saver ? "battery saver is active" : "system is on battery";
    } else if (native?.thermal_pressure) {
      allowed = false;
      mode = "backoff";
      reason = "thermal pressure is active";
    } else if (native?.processor_limit_percent !== null
        && native?.processor_limit_percent !== undefined
        && Number(native.processor_limit_percent) < 60
        && cpuUsedPercent > 50) {
      allowed = false;
      mode = "backoff";
      reason = `processor power limit is ${native.processor_limit_percent}% under load`;
    } else if (!duringRun && cpuUsedPercent > resources.maximumUsedCpuPercent) {
      allowed = false;
      mode = "sampling";
      reason = `CPU use ${cpuUsedPercent.toFixed(1)}% exceeds ${resources.maximumUsedCpuPercent}%`;
    } else if (!duringRun && provider !== "cpu" && !gpu.available) {
      allowed = false;
      mode = "backoff";
      reason = gpu.reason || "GPU telemetry is unavailable";
    } else if (!duringRun && gpu.available && gpu.utilizationPercent > resources.maximumGpuUtilPercent) {
      allowed = false;
      mode = "sampling";
      reason = `GPU use ${gpu.utilizationPercent}% exceeds ${resources.maximumGpuUtilPercent}%`;
    } else if (!duringRun && native && Number(native.input_idle_ms) < resources.inputIdleMs) {
      allowed = false;
      mode = "sampling";
      reason = `input idle ${native.input_idle_ms}ms is below ${resources.inputIdleMs}ms`;
    }
    if (!duringRun) this.idleSamples = allowed ? this.idleSamples + 1 : 0;
    if (!duringRun && allowed && this.idleSamples < resources.consecutiveIdleSamples) {
      allowed = false;
      mode = "sampling";
      reason = `idle sample ${this.idleSamples}/${resources.consecutiveIdleSamples}`;
    } else if (allowed) {
      mode = duringRun ? "running_authorized" : "idle_authorized";
    }
    this.last = {
      allowed,
      mode,
      reason,
      idleSamples: this.idleSamples,
      cpuUsedPercent: Number(cpuUsedPercent.toFixed(1)),
      gpu,
      availableMemoryGb: Number(availableMemoryGb.toFixed(1)),
      usedMemoryPercent: Number(usedMemoryPercent.toFixed(1)),
      freeWorkspaceGb: Number(freeWorkspaceGb.toFixed(1)),
      inputIdleMs: native?.input_idle_ms ?? null,
      onBattery: Boolean(native?.on_battery),
      foregroundDemand,
      restaurantOwnerActive,
      ownerObservations,
      runningProcesses,
      sampledAt: new Date().toISOString(),
    };
    return this.last;
  }

  close() {
    this.native.close?.();
  }
}
