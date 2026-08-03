import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";

const STALE_LOCK_AGE_MS = 10_000;

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function lockState(filename) {
  try {
    const [body, info] = await Promise.all([
      readFile(filename, "utf8"),
      stat(filename),
    ]);
    const value = JSON.parse(body);
    return {
      exists: true,
      owner: value,
      ageMs: Math.max(0, Date.now() - info.mtimeMs),
      valid: Number.isSafeInteger(value?.pid)
        && value.pid > 0
        && typeof value?.nonce === "string"
        && value.nonce.length > 0,
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { exists: false, owner: null, ageMs: 0, valid: false };
    }
    try {
      const info = await stat(filename);
      return {
        exists: true,
        owner: null,
        ageMs: Math.max(0, Date.now() - info.mtimeMs),
        valid: false,
      };
    } catch (statError) {
      if (statError?.code === "ENOENT") {
        return { exists: false, owner: null, ageMs: 0, valid: false };
      }
      throw error;
    }
  }
}

export async function acquirePruneLock(lockDirectory) {
  if (typeof lockDirectory !== "string" || !lockDirectory.trim()) {
    throw new Error("Evidence prune requires a lock directory");
  }
  const directory = path.resolve(lockDirectory);
  const filename = path.join(directory, "prune.lock");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let handle = null;
  for (let attempt = 0; attempt < 2; ++attempt) {
    try {
      handle = await open(filename, "wx", 0o600);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const state = await lockState(filename);
      const alive = state.valid && processAlive(Number(state.owner.pid));
      if (alive || state.ageMs < STALE_LOCK_AGE_MS || attempt > 0) {
        throw new Error(`another Evidence prune operation owns ${filename}`);
      }
      await rm(filename, { force: true });
    }
  }
  if (!handle) throw new Error(`could not acquire Evidence prune lock ${filename}`);

  const owner = {
    schema: "uci_arena_evidence_prune_lock_v1",
    pid: process.pid,
    nonce: randomUUID(),
    started_at: new Date().toISOString(),
  };
  try {
    await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(filename, { force: true }).catch(() => {});
    throw error;
  }

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await handle.close();
    const state = await lockState(filename);
    if (!state.exists) return;
    if (!state.valid || state.owner.nonce !== owner.nonce || state.owner.pid !== owner.pid) {
      throw new Error(`Evidence prune lock ownership changed before release: ${filename}`);
    }
    await rm(filename, { force: false });
  };
}
