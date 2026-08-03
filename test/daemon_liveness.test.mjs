import assert from "node:assert/strict";
import test from "node:test";

import {
  DAEMON_HEARTBEAT_STALE_MS,
  daemonHeartbeatLiveness,
} from "../src/daemon_liveness.mjs";

const NOW = Date.parse("2026-08-03T23:30:00.000Z");

function atAge(ageMs) {
  return new Date(NOW - ageMs).toISOString();
}

test("daemon heartbeat liveness has exact fresh and stale boundaries", () => {
  assert.deepEqual(daemonHeartbeatLiveness(atAge(299_999), NOW), {
    heartbeat_state: "fresh",
    heartbeat_age_ms: 299_999,
  });
  assert.deepEqual(daemonHeartbeatLiveness(atAge(300_000), NOW), {
    heartbeat_state: "stale",
    heartbeat_age_ms: 300_000,
  });
  assert.equal(DAEMON_HEARTBEAT_STALE_MS, 300_000);
});

test("missing and malformed heartbeats project missing", () => {
  for (const heartbeat of [null, undefined, "", "not-a-timestamp", 0]) {
    assert.deepEqual(daemonHeartbeatLiveness(heartbeat, NOW), {
      heartbeat_state: "missing",
      heartbeat_age_ms: null,
    });
  }
});

test("future heartbeat age clamps to zero", () => {
  assert.deepEqual(
    daemonHeartbeatLiveness(new Date(NOW + 60_000).toISOString(), NOW),
    { heartbeat_state: "fresh", heartbeat_age_ms: 0 },
  );
});

test("classification is independent of daemon phase", () => {
  for (const phase of ["running", "stopped", "failed"]) {
    const projected = { phase, ...daemonHeartbeatLiveness(atAge(1_000), NOW) };
    assert.equal(projected.heartbeat_state, "fresh");
    assert.equal(projected.heartbeat_age_ms, 1_000);
  }
});

test("invalid clock and threshold fail closed", () => {
  assert.throws(() => daemonHeartbeatLiveness(atAge(0), Number.NaN), /clock/);
  assert.throws(() => daemonHeartbeatLiveness(atAge(0), NOW, 0), /threshold/);
  assert.throws(() => daemonHeartbeatLiveness(atAge(0), NOW, 1.5), /threshold/);
});
