import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
} from "node:fs/promises";
import path from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[0-9a-f]{64}$/u;
const STAGED_ARTIFACT = /^([0-9a-f]{64})\.artifact$/u;

function nowIso() {
  return new Date().toISOString();
}

function normalizeCutoff(value) {
  if (typeof value !== "string") throw new Error("prune --before must be an ISO timestamp");
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{3}))?Z$/u.exec(value);
  if (!match) throw new Error("prune --before must be an ISO UTC timestamp");
  const normalizedInput = `${match[1]}.${match[2] ?? "000"}Z`;
  const parsed = new Date(normalizedInput);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== normalizedInput) {
    throw new Error("prune --before must be a real ISO UTC calendar timestamp");
  }
  return normalizedInput;
}

function relativeInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === ""
    || (relative !== ".."
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative));
}

async function exists(filename, fsOps) {
  try {
    await fsOps.lstat(filename);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function physicalPathForMissing(filename, fsOps) {
  const missing = [];
  let current = path.resolve(filename);
  while (!(await exists(current, fsOps))) {
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(filename);
    missing.unshift(path.basename(current));
    current = parent;
  }
  return path.join(await fsOps.realpath(current), ...missing);
}

async function sha256File(filename) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

function publicResult({
  operationId,
  before,
  confirmed,
  artifactCount,
  bytes,
  staged = 0,
  deleted = 0,
  cleanupPending = false,
  quarantine = null,
  recovered,
}) {
  return {
    schema: "uci_arena_evidence_prune_result_v2",
    operationId,
    auditId: operationId,
    before,
    confirmed,
    artifactCount,
    bytes,
    staged,
    deleted,
    cleanupPending,
    quarantine,
    recovered,
  };
}

export class PruneService {
  constructor(
    store,
    config,
    {
      fsOps = { lstat, mkdir, readdir, realpath, rename, rm, rmdir },
      hashFile = sha256File,
    } = {},
  ) {
    if (!store
        || typeof store.candidateStats !== "function"
        || typeof store.withConfirmedPrune !== "function") {
      throw new Error("PruneService requires a prune persistence port");
    }
    if (!config?.paths?.artifacts || !config?.paths?.catalog) {
      throw new Error("PruneService requires Evidence artifact and catalog paths");
    }
    this.store = store;
    this.config = config;
    this.fs = fsOps;
    this.hashFile = hashFile;
    this.artifactRoot = path.resolve(config.paths.artifacts);
    this.quarantineRoot = path.join(this.artifactRoot, ".prune-quarantine");
  }

  async roots() {
    await this.fs.mkdir(this.artifactRoot, { recursive: true, mode: 0o700 });
    await this.fs.mkdir(this.quarantineRoot, { recursive: true, mode: 0o700 });
    return {
      artifact: await this.fs.realpath(this.artifactRoot),
      quarantine: await this.fs.realpath(this.quarantineRoot),
    };
  }

  async assertCatalogDestination(candidate, roots, { requireFile }) {
    if (!SHA256.test(candidate.sha256)) {
      throw new Error(`Evidence prune artifact identity is invalid: ${candidate.sha256}`);
    }
    if (!Number.isSafeInteger(candidate.sizeBytes) || candidate.sizeBytes < 0) {
      throw new Error(`Evidence prune artifact ${candidate.sha256} has an invalid size`);
    }
    if (!path.isAbsolute(candidate.path)) {
      throw new Error(`Evidence prune artifact ${candidate.sha256} path is not absolute`);
    }
    const lexical = path.resolve(candidate.path);
    if (!relativeInside(this.artifactRoot, lexical)
        || relativeInside(this.quarantineRoot, lexical)) {
      throw new Error(`Evidence prune artifact ${candidate.sha256} escapes owned artifact storage`);
    }
    const physical = requireFile
      ? await this.fs.realpath(lexical)
      : await physicalPathForMissing(lexical, this.fs);
    if (!relativeInside(roots.artifact, physical)
        || relativeInside(roots.quarantine, physical)) {
      throw new Error(`Evidence prune artifact ${candidate.sha256} physically escapes owned storage`);
    }
    return lexical;
  }

  async validateCandidate(candidate, roots) {
    const filename = await this.assertCatalogDestination(candidate, roots, { requireFile: true });
    const info = await this.fs.lstat(filename);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`Evidence prune artifact ${candidate.sha256} is not a regular owned file`);
    }
    if (!Number.isSafeInteger(info.size) || info.size !== candidate.sizeBytes) {
      throw new Error(`Evidence prune artifact ${candidate.sha256} size does not match the catalog`);
    }
    const digest = await this.hashFile(filename);
    if (digest !== candidate.sha256) {
      throw new Error(`Evidence prune artifact ${candidate.sha256} digest does not match its identity`);
    }
    return filename;
  }

  async restoreStaged(staged) {
    const failures = [];
    for (const item of [...staged].reverse()) {
      try {
        const sourceExists = await exists(item.quarantine, this.fs);
        const destinationExists = await exists(item.original, this.fs);
        if (!sourceExists && destinationExists) continue;
        if (!sourceExists || destinationExists) {
          throw new Error(`ambiguous restore state for ${item.sha256}`);
        }
        await this.fs.mkdir(path.dirname(item.original), { recursive: true, mode: 0o700 });
        await this.fs.rename(item.quarantine, item.original);
      } catch (error) {
        failures.push(error);
      }
    }
    return failures;
  }

  async cleanupCommitted(operationDirectory, staged) {
    for (const item of staged) {
      await this.fs.rm(item.quarantine, { force: false });
    }
    await this.fs.rmdir(operationDirectory);
  }

  async recover() {
    const roots = await this.roots();
    const recovered = { operations: 0, restored: 0, cleaned: 0 };
    const entries = await this.fs.readdir(this.quarantineRoot, { withFileTypes: true });
    for (const operation of entries) {
      if (!operation.isDirectory() || !UUID.test(operation.name)) {
        throw new Error(`unsafe entry in Evidence prune quarantine: ${operation.name}`);
      }
      const operationDirectory = path.join(this.quarantineRoot, operation.name);
      let restored = 0;
      let cleaned = 0;
      const files = await this.fs.readdir(operationDirectory, { withFileTypes: true });
      for (const entry of files) {
        const match = entry.isFile() ? STAGED_ARTIFACT.exec(entry.name) : null;
        if (!match) {
          throw new Error(`unsafe entry in Evidence prune operation ${operation.name}: ${entry.name}`);
        }
        const sha256 = match[1];
        const stagedPath = path.join(operationDirectory, entry.name);
        const row = this.store.artifact(sha256);
        if (row) {
          const destination = await this.assertCatalogDestination(row, roots, { requireFile: false });
          if (await exists(destination, this.fs)) {
            throw new Error(`Evidence prune recovery found both catalog and quarantine files for ${sha256}`);
          }
          const stagedInfo = await this.fs.lstat(stagedPath);
          if (!stagedInfo.isFile() || stagedInfo.isSymbolicLink()
              || stagedInfo.size !== row.sizeBytes
              || await this.hashFile(stagedPath) !== sha256) {
            throw new Error(`Evidence prune recovery artifact ${sha256} is invalid`);
          }
          await this.fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
          await this.fs.rename(stagedPath, destination);
          ++restored;
        } else {
          await this.fs.rm(stagedPath, { force: false });
          ++cleaned;
        }
      }
      if (restored > 0 && cleaned > 0) {
        throw new Error(`Evidence prune operation ${operation.name} has mixed commit state`);
      }
      await this.fs.rmdir(operationDirectory);
      const audit = this.store.audit(operation.name);
      if (restored > 0 && audit) {
        throw new Error(`rolled-back Evidence prune operation ${operation.name} unexpectedly has an audit row`);
      }
      if (cleaned > 0 && audit?.result?.cleanupPending === true) {
        this.store.updateAuditResult(operation.name, {
          ...audit.result,
          cleanupPending: false,
          quarantine: null,
        });
      }
      ++recovered.operations;
      recovered.restored += restored;
      recovered.cleaned += cleaned;
    }
    return { roots, recovered };
  }

  async run({ before, confirm = "" }) {
    const cutoff = normalizeCutoff(before);
    const { roots, recovered } = await this.recover();
    const operationId = randomUUID();
    const requestedAt = nowIso();
    const confirmed = confirm === "PRUNE";
    if (!confirmed) {
      const stats = this.store.candidateStats(cutoff);
      const result = publicResult({
        operationId,
        before: cutoff,
        confirmed: false,
        artifactCount: stats.artifactCount,
        bytes: stats.bytes,
        recovered,
      });
      this.store.insertAudit({
        id: operationId,
        requestedAt,
        before: cutoff,
        confirmed: false,
        artifactCount: stats.artifactCount,
        bytes: stats.bytes,
        result,
      });
      return result;
    }

    const operationDirectory = path.join(this.quarantineRoot, operationId);
    await this.fs.mkdir(operationDirectory, { recursive: false, mode: 0o700 });
    const staged = [];
    let result;
    try {
      result = await this.store.withConfirmedPrune(cutoff, async ({ stats, candidates }) => {
        for (const candidate of candidates) {
          const original = await this.validateCandidate(candidate, roots);
          const quarantine = path.join(
            operationDirectory,
            `${candidate.sha256}.artifact`,
          );
          if (await exists(quarantine, this.fs)) {
            throw new Error(`Evidence prune quarantine collision for ${candidate.sha256}`);
          }
          await this.fs.rename(original, quarantine);
          staged.push({
            sha256: candidate.sha256,
            original,
            quarantine,
          });
          this.store.deleteCandidate(candidate.sha256);
        }
        if (staged.length !== stats.artifactCount) {
          throw new Error(
            `Evidence prune candidate count changed: expected=${stats.artifactCount} staged=${staged.length}`,
          );
        }
        this.store.reconcileDatasetCounts();
        const pending = publicResult({
          operationId,
          before: cutoff,
          confirmed: true,
          artifactCount: stats.artifactCount,
          bytes: stats.bytes,
          staged: staged.length,
          deleted: staged.length,
          cleanupPending: true,
          quarantine: operationDirectory,
          recovered,
        });
        this.store.insertAudit({
          id: operationId,
          requestedAt,
          before: cutoff,
          confirmed: true,
          artifactCount: stats.artifactCount,
          bytes: stats.bytes,
          result: pending,
        });
        return pending;
      });
    } catch (error) {
      const restorationFailures = await this.restoreStaged(staged);
      try {
        await this.fs.rmdir(operationDirectory);
      } catch {}
      if (restorationFailures.length > 0) {
        throw new AggregateError(
          [error, ...restorationFailures],
          "Evidence prune failed and one or more staged artifacts require recovery",
        );
      }
      throw error;
    }

    try {
      await this.cleanupCommitted(operationDirectory, staged);
      const completed = {
        ...result,
        cleanupPending: false,
        quarantine: null,
      };
      try {
        this.store.updateAuditResult(operationId, completed);
        return completed;
      } catch {
        return result;
      }
    } catch {
      return result;
    }
  }
}

export { normalizeCutoff as normalizePruneCutoff };
