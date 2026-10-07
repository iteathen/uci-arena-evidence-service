import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { TextDecoder } from "node:util";
import processQueryContract from "@uci-arena/background-service-runtime/process-instance-query-contract" with { type: "json" };
import { processIdentityFromJson } from "./process_identity.mjs";

// A maximum identity uses at most six JSON bytes per UTF-16 unit, leaving
// ample room for the owned lock envelope inside the public query byte bound.
export const MAXIMUM_DAEMON_RECORD_BYTES = processQueryContract.maximum_response_bytes;

export async function readDaemonRecord(filename) {
  let handle;
  try {
    const link = await lstat(filename);
    if (!link.isFile() || link.isSymbolicLink()) throw new Error("invalid daemon record file");
    handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAXIMUM_DAEMON_RECORD_BYTES
        || info.dev !== link.dev || info.ino !== link.ino) throw new Error("invalid daemon record file");
    const bytes = Buffer.alloc(MAXIMUM_DAEMON_RECORD_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, length);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    if (length > MAXIMUM_DAEMON_RECORD_BYTES) throw new Error("oversized daemon record");
    const raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length));
    return { value: JSON.parse(raw), raw, modifiedMs: info.mtimeMs };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error("Evidence daemon ownership is malformed or unverifiable");
  } finally {
    await handle?.close();
  }
}

export function daemonOwnerFromRecord(packet) {
  const value = packet.value;
  const pid = value?.pid;
  if (!value || typeof value !== "object" || Array.isArray(value)
      || !Number.isSafeInteger(pid) || pid < processQueryContract.pid_minimum
      || pid > processQueryContract.pid_maximum
      || (value.schema !== undefined && value.schema !== "uci_arena_evidence_daemon_lock_v2")) {
    throw new Error("Evidence daemon ownership is malformed or unverifiable");
  }
  const hasIdentity = Object.hasOwn(value, "processIdentity");
  const allowed = value.schema === "uci_arena_evidence_daemon_lock_v2" || hasIdentity
    ? ["schema", "pid", "nonce", "started_at", "processIdentity"]
    : ["pid", "nonce", "started_at"];
  if (Object.keys(value).some((field) => !allowed.includes(field))) {
    throw new Error("Evidence daemon ownership is malformed or unverifiable");
  }
  if (hasIdentity && (!value.processIdentity || typeof value.processIdentity !== "object"
      || Array.isArray(value.processIdentity))) {
    throw new Error("Evidence daemon ownership is malformed or unverifiable");
  }
  const identity = hasIdentity ? processIdentityFromJson(value.processIdentity, pid) : null;
  if ((hasIdentity || value.schema === "uci_arena_evidence_daemon_lock_v2") && !identity) {
    throw new Error("Evidence daemon ownership is malformed or unverifiable");
  }
  return { pid, identity, nonce: typeof value.nonce === "string" ? value.nonce : "", raw: packet.raw };
}
