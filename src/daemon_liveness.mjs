export const DAEMON_HEARTBEAT_STALE_MS = 300_000;

export function daemonHeartbeatLiveness(
  heartbeatAt,
  nowMs = Date.now(),
  staleMs = DAEMON_HEARTBEAT_STALE_MS,
) {
  if (!Number.isFinite(nowMs)) throw new Error("daemon heartbeat clock must be finite");
  if (!Number.isSafeInteger(staleMs) || staleMs < 1) {
    throw new Error("daemon heartbeat stale threshold must be a positive safe integer");
  }
  const heartbeatMs = typeof heartbeatAt === "string"
    ? Date.parse(heartbeatAt)
    : Number.NaN;
  if (!Number.isFinite(heartbeatMs)) {
    return {
      heartbeat_state: "missing",
      heartbeat_age_ms: null,
    };
  }
  const ageMs = Math.max(0, Math.floor(nowMs - heartbeatMs));
  return {
    heartbeat_state: ageMs >= staleMs ? "stale" : "fresh",
    heartbeat_age_ms: ageMs,
  };
}

export function projectDaemonHeartbeatStatus(status, nowMs = Date.now()) {
  if (!status || typeof status !== "object" || Array.isArray(status)) {
    throw new Error("Evidence status projection requires an object");
  }
  const daemon = status.daemon && typeof status.daemon === "object"
    && !Array.isArray(status.daemon)
    ? status.daemon
    : {};
  return {
    ...status,
    daemon: {
      ...daemon,
      ...daemonHeartbeatLiveness(daemon.heartbeatAt, nowMs),
    },
  };
}
