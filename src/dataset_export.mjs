import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";

function protectedCatalogPaths(readStore) {
  const catalog = path.resolve(readStore.filename);
  return new Set([
    catalog,
    `${catalog}-wal`,
    `${catalog}-shm`,
    `${catalog}-journal`,
  ]);
}

function assertDestination(readStore, destination) {
  if (protectedCatalogPaths(readStore).has(destination)) {
    throw new Error("dataset export destination cannot replace the Evidence catalog or its sidecars");
  }
}

async function writeText(handle, state, text) {
  const buffer = Buffer.from(text, "utf8");
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(
      buffer,
      offset,
      buffer.length - offset,
      state.position,
    );
    if (!Number.isInteger(bytesWritten) || bytesWritten <= 0) {
      throw new Error("dataset export write made no progress");
    }
    offset += bytesWritten;
    state.position += bytesWritten;
  }
}

function indentedJson(value, spaces) {
  const prefix = " ".repeat(spaces);
  return JSON.stringify(value, null, 2)
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

async function serializeJson(handle, state, summary, observations) {
  const summaryText = JSON.stringify(summary, null, 2);
  const closingLine = summaryText.lastIndexOf("\n}");
  if (closingLine < 0) throw new Error("dataset summary did not serialize as an object");
  await writeText(
    handle,
    state,
    `${summaryText.slice(0, closingLine)},\n  "observations": [`,
  );
  let count = 0;
  for (const observation of observations) {
    await writeText(handle, state, count === 0 ? "\n" : ",\n");
    await writeText(handle, state, indentedJson(observation, 4));
    ++count;
  }
  await writeText(handle, state, "\n  ]\n}\n");
  return count;
}

async function serializeJsonLines(handle, state, observations) {
  let count = 0;
  for (const observation of observations) {
    await writeText(handle, state, `${JSON.stringify(observation)}\n`);
    ++count;
  }
  if (count === 0) await writeText(handle, state, "\n");
  return count;
}

export async function exportDataset(
  readStore,
  { datasetId, out, format = "jsonl" },
) {
  if (!readStore || typeof readStore.withDatasetSnapshot !== "function") {
    throw new Error("dataset export requires a dataset read port");
  }
  if (typeof readStore.filename !== "string" || !readStore.filename.trim()) {
    throw new Error("dataset export read port must identify its catalog file");
  }
  if (typeof datasetId !== "string" || !datasetId.trim()) {
    throw new Error("dataset export requires a dataset id");
  }
  if (typeof out !== "string" || !out.trim()) {
    throw new Error("dataset export requires an output path");
  }
  if (format !== "json" && format !== "jsonl") {
    throw new Error("dataset export format must be json or jsonl");
  }

  const filename = path.resolve(out);
  assertDestination(readStore, filename);
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  let handle = null;
  let temporaryExists = false;
  let published = false;
  try {
    const result = await readStore.withDatasetSnapshot(
      datasetId,
      async (summary, observations) => {
        await mkdir(path.dirname(filename), { recursive: true });
        handle = await open(temporary, "wx", 0o600);
        temporaryExists = true;
        const state = { position: 0 };
        const count = format === "json"
          ? await serializeJson(handle, state, summary, observations)
          : await serializeJsonLines(handle, state, observations);
        if (count !== summary.observationCount) {
          throw new Error(
            `dataset export count mismatch: catalog=${summary.observationCount} written=${count}`,
          );
        }
        await handle.sync();
        await handle.close();
        handle = null;
        return {
          datasetId,
          format,
          filename,
          observations: count,
        };
      },
    );
    if (result === null) return null;
    await rename(temporary, filename);
    temporaryExists = false;
    published = true;
    return result;
  } finally {
    if (handle !== null) {
      try {
        await handle.close();
      } catch {}
    }
    if (temporaryExists || !published) {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }
}
