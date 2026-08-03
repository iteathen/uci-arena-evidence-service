export const DAEMON_HEARTBEAT_MS = 15_000;
export const DAEMON_CYCLE_MS = 60_000;
export const DAEMON_STALE_MS = 300_000;

const DAEMON_KEYS = Object.freeze([
  "heartbeatMs",
  "cycleMs",
  "staleMs",
]);

export function canonicalDaemonTiming() {
  return {
    heartbeatMs: DAEMON_HEARTBEAT_MS,
    cycleMs: DAEMON_CYCLE_MS,
    staleMs: DAEMON_STALE_MS,
  };
}

export function validateDaemonTiming(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("daemon timing must be an object");
  }
  const keys = Object.keys(value).sort();
  const expected = [...DAEMON_KEYS].sort();
  if (keys.length !== expected.length
      || keys.some((key, index) => key !== expected[index])) {
    throw new Error("daemon timing must contain only heartbeatMs, cycleMs, and staleMs");
  }

  const canonical = canonicalDaemonTiming();
  for (const key of DAEMON_KEYS) {
    if (!Number.isSafeInteger(value[key]) || value[key] !== canonical[key]) {
      throw new Error(`daemon.${key} must equal ${canonical[key]}`);
    }
  }
  return value;
}
