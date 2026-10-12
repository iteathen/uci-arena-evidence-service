import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import processQueryContract from "@uci-arena/background-service-runtime/process-instance-query-contract" with { type: "json" };
import processStopContract from "@uci-arena/background-service-runtime/process-instance-stop-contract" with { type: "json" };

export const PROCESS_INSTANCE_IDENTITY_SCHEMA = processQueryContract.identity_schema;
let cachedCurrentIdentity = null;

let windowsQuery = null;
let windowsStop = null;

// Composition qualifies the explicitly selected native dependency before any
// Windows identity consumer runs. This does not start its supervisor.
export async function configureProcessIdentityProbe(helper) {
  if (process.platform !== "win32") return;
  windowsQuery = null;
  windowsStop = null;
  cachedCurrentIdentity = null;
  const probe = await helper.probe();
  if (!Array.isArray(probe?.capabilities)
      || !probe.capabilities.includes(processQueryContract.capability)
      || typeof helper.queryProcessInstanceSync !== "function") {
    throw new Error("native process instance query capability is unavailable");
  }
  windowsQuery = helper.queryProcessInstanceSync.bind(helper);
  if (probe.capabilities.includes(processStopContract.capability)
      && typeof helper.stopProcessInstanceSync === "function") {
    windowsStop = helper.stopProcessInstanceSync.bind(helper);
  }
}

export function requireProcessStopCapability() {
  if (process.platform !== 'win32' || !windowsStop) {
    throw new Error('native process instance stop capability is unavailable');
  }
}

export function stopProcessInstance(identity, { timeoutMs = processStopContract.timeout_ms } = {}) {
  requireProcessStopCapability();
  const expected = processIdentityFromJson(identity);
  if (!expected || expected.platform !== 'win32') throw new Error('invalid Windows daemon incarnation');
  const result = windowsStop(expected, { timeoutMs });
  if (!result || typeof result !== 'object' || Array.isArray(result)
      || Object.keys(result).length !== processStopContract.response_fields.length
      || !processStopContract.response_fields.every(field => Object.hasOwn(result, field))
      || result.schema !== processStopContract.response_schema
      || !processStopContract.states.includes(result.state)) {
    return { schema: processStopContract.response_schema, state: 'unverifiable' };
  }
  return result;
}

function normalizedExecutable(identity) {
  const value = String(identity?.executable_path ?? "");
  return identity?.platform === "win32"
    ? path.win32.normalize(value).toLocaleLowerCase("en-US")
    : path.normalize(value);
}

export function validProcessIdentity(value, expectedPid = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).length !== processQueryContract.identity_fields.length
      || !processQueryContract.identity_fields.every((field) => Object.hasOwn(value, field))
      || value.schema !== PROCESS_INSTANCE_IDENTITY_SCHEMA
      || !["win32", "linux"].includes(value.platform)
      || !Number.isSafeInteger(value.pid) || value.pid < processQueryContract.pid_minimum
      || value.pid > processQueryContract.pid_maximum
      || (expectedPid !== null && value.pid !== expectedPid)
      || typeof value.start_token !== "string" || !/^[0-9]{1,32}$/u.test(value.start_token)
      || typeof value.executable_path !== "string" || !value.executable_path.isWellFormed()
      || value.executable_path.length === 0 || /[\u0000\r\n]/u.test(value.executable_path)
      || typeof value.boot_id !== "string" || value.boot_id.length > 128) return false;
  if (value.platform === "linux") return value.executable_path.length <= 4096;
  const root = path.win32.parse(value.executable_path).root;
  if (value.executable_path.length > processQueryContract.maximum_executable_path_utf16_units
      || !(/^[a-z]:[\\/]/iu.test(root) || root.startsWith("\\\\"))
      || !/^[0-9]{1,19}$/u.test(value.start_token) || value.boot_id !== "") return false;
  const ticks = BigInt(value.start_token);
  return ticks >= BigInt(processQueryContract.creation_tick_minimum)
    && ticks <= BigInt(processQueryContract.creation_tick_maximum);
}

export function sameProcessInstance(left, right) {
  return validProcessIdentity(left)
    && validProcessIdentity(right)
    && left.platform === right.platform
    && left.pid === right.pid
    && String(left.start_token) === String(right.start_token)
    && String(left.boot_id) === String(right.boot_id)
    && normalizedExecutable(left) === normalizedExecutable(right);
}

function linuxProcessIdentity(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close < 0) return { state: "unverifiable" };
    const fields = stat.slice(close + 2).trim().split(/\s+/u);
    const identity = {
      schema: PROCESS_INSTANCE_IDENTITY_SCHEMA,
      platform: "linux",
      pid,
      start_token: fields[19],
      executable_path: realpathSync(`/proc/${pid}/exe`),
      boot_id: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
    };
    return validProcessIdentity(identity, pid)
      ? { state: "present", identity }
      : { state: "unverifiable" };
  } catch (error) {
    return ["ENOENT", "ESRCH"].includes(error?.code)
      ? { state: "absent" }
      : { state: "unverifiable" };
  }
}

function windowsProcessIdentity(pid, timeoutMs) {
  try {
    const result = windowsQuery?.(pid, { timeoutMs });
    if (result?.schema !== processQueryContract.response_schema) return { state: "unverifiable" };
    if (result.state === "absent" || result.state === "unverifiable") return { state: result.state };
    return result.state === "present" && validProcessIdentity(result.identity, pid)
      ? { state: "present", identity: result.identity }
      : { state: "unverifiable" };
  } catch {
    return { state: "unverifiable" };
  }
}

export function probeProcessInstance(pid, { timeoutMs = processQueryContract.timeout_ms } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffff_ffff) {
    return { state: "absent" };
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > processQueryContract.timeout_ms) {
    return { state: "unverifiable" };
  }
  if (process.platform === "linux") return linuxProcessIdentity(pid);
  if (process.platform === "win32") return windowsProcessIdentity(pid, timeoutMs);
  return { state: "unverifiable" };
}

export function currentProcessIdentity() {
  if (cachedCurrentIdentity) return cachedCurrentIdentity;
  const result = probeProcessInstance(process.pid);
  if (result.state !== "present") {
    throw new Error("current process instance identity is unavailable");
  }
  cachedCurrentIdentity = Object.freeze(result.identity);
  return cachedCurrentIdentity;
}

export function processIdentityFromJson(value, expectedPid = null) {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return validProcessIdentity(parsed, expectedPid) ? parsed : null;
  } catch {
    return null;
  }
}

export function processInstanceIsCurrent(value, probe = probeProcessInstance) {
  const identity = processIdentityFromJson(value);
  if (!identity) return false;
  const current = identity.pid === process.pid
    ? { state: "present", identity: currentProcessIdentity() }
    : probe(identity.pid);
  return current?.state === "present" && sameProcessInstance(identity, current.identity);
}
