import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Catalog } from "../src/catalog.mjs";
import { PruneOperation } from "../src/prune_operation.mjs";
import { PruneStore } from "../src/prune_store.mjs";

function configFor(root) {
  return {
    workspace: root,
    activeModelPointer: path.join(root, "missing-active-model.json"),
    paths: {
      catalog: path.join(root, "catalog.sqlite"),
      artifacts: path.join(root, "artifacts"),
      attempts: path.join(root, "attempts"),
      exports: path.join(root, "exports"),
      locks: path.join(root, "locks"),
      profiles: path.join(root, "profiles"),
    },
  };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "arena-evidence-prune-lease-"));
  const config = configFor(root);
  const catalog = new Catalog(config);
  const first = new PruneStore(config.paths.catalog);
  const second = new PruneStore(config.paths.catalog);
  t.after(() => second.close());
  t.after(() => first.close());
  t.after(() => catalog.close());
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, config, catalog, first, second };
}

test("metadata prune lease excludes a concurrent live owner and is reacquirable", async (t) => {
  const { first, second } = await fixture(t);
  let now = 1_000;
  const lease = first.acquireOperationLease({
    pid: 101,
    processAliveImpl: (pid) => pid === 101,
    nowMs: () => now,
  });

  assert.throws(
    () => second.acquireOperationLease({
      pid: 202,
      processAliveImpl: (pid) => pid === 101,
      nowMs: () => now + 1,
    }),
    /another Evidence prune operation is active/,
  );

  lease.release();
  const replacement = second.acquireOperationLease({
    pid: 202,
    processAliveImpl: () => true,
    nowMs: () => now + 2,
  });
  replacement.release();
});

test("dead or stale prune leases are replaced transactionally", async (t) => {
  const { first, second } = await fixture(t);
  let now = 1_000;
  const dead = first.acquireOperationLease({
    pid: 101,
    processAliveImpl: () => false,
    nowMs: () => now,
  });
  now += 1;
  const takeover = second.acquireOperationLease({
    pid: 202,
    processAliveImpl: () => false,
    nowMs: () => now,
  });
  assert.throws(dead.heartbeat, /ownership changed during heartbeat/);
  assert.throws(dead.release, /ownership changed before release/);
  takeover.release();

  const liveButStale = first.acquireOperationLease({
    pid: 303,
    processAliveImpl: () => true,
    nowMs: () => 10_000,
  });
  const staleTakeover = second.acquireOperationLease({
    pid: 404,
    processAliveImpl: (pid) => pid === 303,
    nowMs: () => 50_001,
  });
  assert.throws(liveButStale.heartbeat, /ownership changed during heartbeat/);
  staleTakeover.release();
});

test("lease heartbeat keeps a live owner authoritative", async (t) => {
  const { first, second } = await fixture(t);
  let now = 1_000;
  const lease = first.acquireOperationLease({
    pid: 101,
    processAliveImpl: (pid) => pid === 101,
    nowMs: () => now,
  });
  now = 25_000;
  lease.heartbeat();
  now = 40_000;
  assert.throws(
    () => second.acquireOperationLease({
      pid: 202,
      processAliveImpl: (pid) => pid === 101,
      nowMs: () => now,
    }),
    /another Evidence prune operation is active/,
  );
  lease.release();
});

function operationFixture({
  workflow,
  lease,
  timerCallback = null,
} = {}) {
  const events = [];
  let intervalCallback = timerCallback;
  const selectedLease = lease ?? {
    heartbeat() { events.push("heartbeat"); },
    release() { events.push("release"); },
  };
  const operation = new PruneOperation(null, {}, {
    leaseFactory: async () => {
      events.push("acquire");
      return selectedLease;
    },
    workflow: workflow ?? {
      async run(input) {
        events.push("run");
        input.heartbeat();
        return { ok: true };
      },
    },
    heartbeatIntervalMs: 100,
    setIntervalImpl(callback) {
      intervalCallback = callback;
      return { unref() { events.push("unref"); } };
    },
    clearIntervalImpl() { events.push("clear"); },
  });
  return {
    operation,
    events,
    interval: () => intervalCallback?.(),
  };
}

test("prune operation releases its lease after success and workflow failure", async () => {
  const success = operationFixture();
  assert.deepEqual(await success.operation.run({ before: "cutoff" }), { ok: true });
  assert.deepEqual(success.events, [
    "acquire",
    "heartbeat",
    "unref",
    "run",
    "heartbeat",
    "heartbeat",
    "clear",
    "release",
  ]);

  const failure = operationFixture({
    workflow: {
      async run() { throw new Error("workflow failed"); },
    },
  });
  await assert.rejects(failure.operation.run({}), /workflow failed/);
  assert.ok(failure.events.includes("release"));
  assert.ok(failure.events.includes("clear"));
});

test("workflow heartbeat observes an asynchronous lease failure", async () => {
  let calls = 0;
  let trigger = null;
  const operation = new PruneOperation(null, {}, {
    leaseFactory: async () => ({
      heartbeat() {
        ++calls;
        if (calls >= 2) throw new Error("lease heartbeat failed");
      },
      release() {},
    }),
    workflow: {
      async run({ heartbeat }) {
        trigger();
        heartbeat();
      },
    },
    heartbeatIntervalMs: 100,
    setIntervalImpl(callback) {
      trigger = callback;
      return { unref() {} };
    },
    clearIntervalImpl() {},
  });

  await assert.rejects(operation.run({}), /lease heartbeat failed/);
});

test("workflow heartbeat and release failures are preserved together", async () => {
  const operation = new PruneOperation(null, {}, {
    leaseFactory: async () => ({
      heartbeat() {},
      release() { throw new Error("release failed"); },
    }),
    workflow: {
      async run() { throw new Error("workflow failed"); },
    },
    heartbeatIntervalMs: 100,
    setIntervalImpl() { return { unref() {} }; },
    clearIntervalImpl() {},
  });

  await assert.rejects(
    operation.run({}),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /lease lifecycle failed/);
      assert.equal(error.errors.length, 2);
      return true;
    },
  );
});
