import assert from "node:assert/strict";
import { readFile, utimes, writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { acquirePruneLock } from "../src/prune_lock.mjs";
import { PruneOperation } from "../src/prune_operation.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "arena-evidence-prune-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, locks: path.join(root, "locks") };
}

test("prune lock excludes concurrent owners and is reacquirable after release", async (t) => {
  const { locks } = await fixture(t);
  const release = await acquirePruneLock(locks);

  await assert.rejects(
    acquirePruneLock(locks),
    /another Evidence prune operation owns/,
  );

  await release();
  const releaseAgain = await acquirePruneLock(locks);
  await releaseAgain();
});

test("dead stale prune locks are recovered but live owners remain authoritative", async (t) => {
  const { locks } = await fixture(t);
  const filename = path.join(locks, "prune.lock");
  await fsMkdir(locks);
  await writeFile(filename, `${JSON.stringify({
    schema: "uci_arena_evidence_prune_lock_v1",
    pid: 2_147_483_647,
    nonce: "stale",
    started_at: "2020-01-01T00:00:00.000Z",
  })}\n`, "utf8");
  const old = new Date(Date.now() - 60_000);
  await utimes(filename, old, old);
  const release = await acquirePruneLock(locks);
  await release();

  await writeFile(filename, `${JSON.stringify({
    schema: "uci_arena_evidence_prune_lock_v1",
    pid: process.pid,
    nonce: "live",
    started_at: "2020-01-01T00:00:00.000Z",
  })}\n`, "utf8");
  await utimes(filename, old, old);
  await assert.rejects(
    acquirePruneLock(locks),
    /another Evidence prune operation owns/,
  );
});

async function fsMkdir(directory) {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(directory, { recursive: true });
}

test("prune operation releases its lock after success and workflow failure", async (t) => {
  const { locks } = await fixture(t);
  const events = [];
  const lockFactory = async (directory) => {
    events.push(["acquire", directory]);
    return async () => { events.push(["release", directory]); };
  };
  const success = new PruneOperation(null, { paths: { locks } }, {
    lockFactory,
    workflow: { async run(input) { events.push(["run", input]); return { ok: true }; } },
  });
  assert.deepEqual(await success.run({ before: "cutoff" }), { ok: true });
  assert.deepEqual(events.map(([event]) => event), ["acquire", "run", "release"]);

  events.length = 0;
  const failure = new PruneOperation(null, { paths: { locks } }, {
    lockFactory,
    workflow: { async run() { events.push(["run"]); throw new Error("workflow failed"); } },
  });
  await assert.rejects(failure.run({}), /workflow failed/);
  assert.deepEqual(events.map(([event]) => event), ["acquire", "run", "release"]);
});

test("workflow and lock-release failures are preserved together", async (t) => {
  const { locks } = await fixture(t);
  const operation = new PruneOperation(null, { paths: { locks } }, {
    lockFactory: async () => async () => { throw new Error("release failed"); },
    workflow: { async run() { throw new Error("workflow failed"); } },
  });

  await assert.rejects(
    operation.run({}),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /both failed/);
      assert.equal(error.errors.length, 2);
      return true;
    },
  );
});

test("lock release refuses to remove a file whose ownership changed", async (t) => {
  const { locks } = await fixture(t);
  const filename = path.join(locks, "prune.lock");
  const release = await acquirePruneLock(locks);
  const owner = JSON.parse(await readFile(filename, "utf8"));
  await writeFile(filename, `${JSON.stringify({ ...owner, nonce: "substituted" })}\n`, "utf8");

  await assert.rejects(
    release(),
    /lock ownership changed before release/,
  );
});
