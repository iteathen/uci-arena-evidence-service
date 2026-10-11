import { createHash } from 'node:crypto';
import { constants, lstatSync, openSync, fstatSync, readSync, writeSync, closeSync, mkdtempSync, unlinkSync, rmdirSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { readDaemonRecord, daemonOwnerFromRecord } from './daemon_owner_record.mjs';
import { processIdentityFromJson, validProcessIdentity, sameProcessInstance, probeProcessInstance } from './process_identity.mjs';
import { offlineStartupPresence, STARTUP_PRESENCE_SCHEMA } from './platform_startup.mjs';

export const LOCATOR_ADOPTION_SCHEMA = 'uci_arena_evidence_locator_adoption_v1';
const MAXIMUM_BYTES = 1_099_511_627_776;
const MAXIMUM_ROWS = 1_000_000;
const MAXIMUM_PLAN_BYTES = 64 * 1024 * 1024;
class Deferred extends Error { constructor(reason) { super('Offline locator adoption deferred'); this.reason = reason; } }
const defer = reason => { throw new Deferred(reason); };
const sameIdentity = (a,b) => a.dev === b.dev && a.ino === b.ino;
const sameMetadata = (a,b) => sameIdentity(a,b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
function absolute(value) {
  if (typeof value !== 'string' || !value.isWellFormed() || value.length > 32767
      || !path.isAbsolute(value) || /[\u0000-\u001f\u007f]/u.test(value)
      || value.slice(path.parse(value).root.length).includes(':')) defer('invalid_request');
  return path.resolve(value);
}
function contained(root, file) {
  const relative = path.relative(root,file);
  return relative && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
}
function admit(filename, directory = false) {
  const resolved = absolute(filename), root = path.parse(resolved).root;
  let current = root;
  for (const part of path.relative(root,resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current,part);
    const info = lstatSync(current);
    if (info.isSymbolicLink() || (current !== resolved && !info.isDirectory())) defer('file_unavailable');
  }
  const info = lstatSync(resolved);
  if (directory ? !info.isDirectory() : !info.isFile() || info.size > MAXIMUM_BYTES) defer('file_unavailable');
  return info;
}
function absentHistoricalRoot(root) {
  // Every parent must exist and be ordinary; only the declared leaf ENOENT
  // establishes this retired locator namespace. No unavailable owner is guessed.
  admit(path.dirname(root),true);
  try { lstatSync(root); } catch (error) { if (error?.code === 'ENOENT') return; throw error; }
  defer('file_unavailable');
}
const pathKey = value => process.platform === 'win32' ? value.toLowerCase() : value;
const overlap = (left,right) => pathKey(left) === pathKey(right) || contained(left,right) || contained(right,left);
function fileProof(filename, check, copyFilename = null, created = null) {
  check(); const info = admit(filename), handle = openSync(filename,constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let output = null;
  try {
    if (copyFilename) { output = openSync(copyFilename,'wx',0o600); created?.(copyFilename,fstatSync(output)); }
    if (!sameMetadata(info,fstatSync(handle))) defer('source_changed');
    const digest = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024); let bytes = 0;
    while (true) { check(); const n = readSync(handle,buffer,0,buffer.length,null); if (!n) break;
      bytes += n; if (bytes > MAXIMUM_BYTES) defer('resource_limit'); digest.update(buffer.subarray(0,n));
      if (output !== null) { let written = 0; while (written < n) { check(); const count = writeSync(output,buffer,written,n-written,null);
        if (!count) defer('file_unavailable'); written += count; } }
    }
    if (bytes !== info.size || !sameMetadata(info,fstatSync(handle)) || !sameMetadata(info,admit(filename))) defer('source_changed');
    return { filename, identity: info, bytes, sha256: digest.digest('hex') };
  } finally { try { if (output !== null) closeSync(output); } finally { closeSync(handle); } }
}
function openCatalog(filename, readOnly, recordFiles = () => {}) {
  admit(filename);
  for (const suffix of ['-wal','-shm','-journal']) {
    try { admit(filename + suffix); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
  const db = new DatabaseSync(filename,{readOnly});
  try {
    db.exec('PRAGMA busy_timeout=1000;');
    if (db.prepare("SELECT value FROM metadata WHERE key='schema_version' AND length(CAST(value AS BLOB))<=32").get()?.value !== '3') defer('catalog_unavailable');
    if (db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' LIMIT 1").get()) defer('catalog_unavailable');
    recordFiles();
    return db;
  } catch (error) { try { recordFiles(); } finally { db.close(); } throw error; }
}
function authority(db) {
  const length = db.prepare('SELECT length(CAST(last_report_json AS BLOB)) AS report_bytes, length(CAST(process_identity_json AS BLOB)) AS identity_bytes FROM daemon_state WHERE singleton=1').get();
  if (!length || length.report_bytes > 262144 || length.identity_bytes > 262144) defer('catalog_unavailable');
  if (db.prepare('SELECT length(CAST(reason AS BLOB)) AS bytes FROM control WHERE singleton=1').get()?.bytes > 262144) defer('catalog_unavailable');
  return { control: db.prepare('SELECT * FROM control WHERE singleton=1').get(), daemon: db.prepare('SELECT * FROM daemon_state WHERE singleton=1').get() };
}
function locatorRows(db, check) {
  const artifacts = [], attempts = []; let bytes = 0, rows = 0;
  const bounded = (column,limit) => `CASE WHEN length(CAST(${column} AS BLOB))<=${limit} THEN ${column} ELSE NULL END AS ${column}`;
  for (const [table,columns,target] of [['artifacts',[bounded('sha256',64),bounded('schema',4096),bounded('path',131068),'size_bytes'].join(','),artifacts],
    ['attempts',[bounded('id',256),bounded('stdout_path',131068),bounded('stderr_path',131068)].join(','),attempts]]) {
    for (const row of db.prepare(`SELECT ${columns} FROM ${table} ORDER BY ${table === 'artifacts' ? 'sha256' : 'id'}`).iterate()) {
      check(); bytes += Buffer.byteLength(JSON.stringify(row)); rows++;
      if (rows > MAXIMUM_ROWS || bytes > MAXIMUM_PLAN_BYTES) defer('resource_limit'); target.push(row);
    }
  }
  return { artifacts, attempts };
}
async function owners(config, state, probe, check) {
  const ids = [];
  const pidValid = pid => Number.isSafeInteger(pid) && pid >= 1 && pid <= 0xffff_ffff;
  const stampValid = value => {
    if (typeof value !== 'string' || value.length > 32) return false;
    try { return new Date(value).toISOString() === value; } catch { return false; }
  };
  const legacyRecord = (value,timeField,optionalNonce = false) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !pidValid(value.pid) || !stampValid(value[timeField])) return false;
    const allowed = ['pid',timeField,...(optionalNonce ? ['nonce'] : [])];
    return Object.keys(value).every(k=>allowed.includes(k))
      && (!Object.hasOwn(value,'nonce') || typeof value.nonce === 'string' && value.nonce.length >= 1 && value.nonce.length <= 128);
  };
  const legacyCatalog = value => {
    const fields = ['singleton','pid','phase','current_job_id','resource_mode','started_at','heartbeat_at',
      'cycle_started_at','cycle_completed_at','last_error','last_report_json','process_identity_json'];
    return Object.keys(value).length === fields.length && fields.every(k=>Object.hasOwn(value,k)) && value.singleton === 1
      && pidValid(value.pid) && value.process_identity_json === '' && ['stopped','sampling','sleep','failed'].includes(value.phase)
      && stampValid(value.started_at) && stampValid(value.heartbeat_at)
      && [value.cycle_started_at,value.cycle_completed_at].every(v=>v === null || stampValid(v))
      && (value.current_job_id === null || typeof value.current_job_id === 'string' && value.current_job_id.length >= 1 && value.current_job_id.length <= 256)
      && typeof value.resource_mode === 'string' && value.resource_mode.length <= 256
      && typeof value.last_error === 'string' && value.last_error.length <= 262144
      && typeof value.last_report_json === 'string' && value.last_report_json.length <= 262144;
  };
  if (!state?.daemon || !state?.control) defer('catalog_unavailable');
  const daemon = state.daemon;
  if (daemon.pid !== null || daemon.process_identity_json) {
    const identity = processIdentityFromJson(daemon.process_identity_json,daemon.pid);
    if (!identity && !legacyCatalog(daemon)) defer('daemon_unverifiable'); ids.push({pid:daemon.pid,identity});
  } else if (!['stopped','failed'].includes(daemon.phase)) defer('daemon_unverifiable');
  for (const [name,heartbeat] of [['daemon.lock',false],['daemon.heartbeat.json',true]]) {
    const file = path.join(config.workspace,'locks',name); let packet;
    try { admit(file); packet = await readDaemonRecord(file); } catch (error) { if (error?.code === 'ENOENT') continue; defer('daemon_unverifiable'); }
    check(); if (!packet) defer('source_changed');
    let identity, pid;
    try {
      if (heartbeat) {
        const value = packet.value;
        if (!value || Object.keys(value).some(k=>!['pid','nonce','process_identity','heartbeat_at'].includes(k))) defer('daemon_unverifiable');
        pid = value.pid;
        if (Object.hasOwn(value,'process_identity')) {
          identity = processIdentityFromJson(value.process_identity,pid); if (!identity) defer('daemon_unverifiable');
        } else if (!legacyRecord(value,'heartbeat_at')) defer('daemon_unverifiable');
      } else {
        const owner = daemonOwnerFromRecord(packet); pid = owner.pid; identity = owner.identity;
        if (!identity && !legacyRecord(packet.value,'started_at',true)) defer('daemon_unverifiable');
      }
    } catch { defer('daemon_unverifiable'); }
    ids.push({pid,identity});
  }
  for (const {pid,identity} of ids) {
    if (identity && identity.platform !== process.platform) defer('daemon_unverifiable');
    const timeoutMs = Math.min(2000,Math.max(1,Math.floor(check())));
    let current; try { current = probe(pid,{timeoutMs}); } catch { defer('daemon_unverifiable'); } check();
    if (!(current?.state === 'absent' || identity && current?.state === 'present' && validProcessIdentity(current.identity,pid)
        && current.identity.platform === identity.platform && !sameProcessInstance(identity,current.identity))) defer('daemon_unverifiable');
  }
}
export async function adoptOfflineLocators({ sourceConfig, destinationConfig, historicalLocatorRoots = [], maximumMilliseconds = 60000,
  observeStartup = offlineStartupPresence, processProbe = probeProcessInstance }) {
  const started = performance.now(); let source, destination, stage, stageIdentity, transaction = false, completion = 'not_attempted', result;
  const stageFiles = new Map();
  const check = () => { const remaining = maximumMilliseconds - (performance.now() - started);
    if (remaining <= 0) defer('cancelled_or_timeout'); return remaining; };
  const startup = async () => { for (const config of [sourceConfig,destinationConfig]) {
    const timeoutMs = Math.min(10000,Math.max(1,Math.floor(check())));
    const value = await observeStartup(config,{timeoutMs}); check();
    if (value?.schema !== STARTUP_PRESENCE_SCHEMA || value.state !== 'absent') defer('startup_not_absent'); } };
  try {
    if (!Number.isSafeInteger(maximumMilliseconds) || maximumMilliseconds < 1 || maximumMilliseconds > 60000) defer('invalid_request');
    const oldRoot = absolute(sourceConfig?.workspace), newRoot = absolute(destinationConfig?.workspace);
    if (oldRoot === newRoot || contained(oldRoot,newRoot) || contained(newRoot,oldRoot)) defer('invalid_request');
    if (!Array.isArray(historicalLocatorRoots) || historicalLocatorRoots.length > 8) defer('invalid_request');
    const locatorRoots = [oldRoot];
    for (const value of historicalLocatorRoots) {
      const root = absolute(value);
      if (locatorRoots.some(other=>overlap(root,other)) || overlap(root,newRoot)) defer('invalid_request');
      locatorRoots.push(root);
    }
    const historicalAbsence = () => { for (const root of locatorRoots.slice(1)) { check(); absentHistoricalRoot(root); } };
    historicalAbsence();
    admit(oldRoot,true); admit(newRoot,true);
    const oldFile = path.join(oldRoot,'catalog.sqlite'), newFile = path.join(newRoot,'catalog.sqlite');
    const oldIdentity = admit(oldFile), newIdentity = admit(newFile);
    if (sameIdentity(oldIdentity,newIdentity)) defer('invalid_request');
    for (const file of [oldFile,newFile]) {
      try { admit(file + '-journal'); defer('catalog_unavailable'); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    }
    await startup();
    stage = mkdtempSync(path.join(newRoot,'.locator-source-')); stageIdentity = admit(stage,true);
    const stagedFile = path.join(stage,'catalog.sqlite');
    const created = (file,identity) => stageFiles.set(file,identity);
    const originalCatalogProofs = [fileProof(oldFile,check,stagedFile,created)];
    stageFiles.set(stagedFile,admit(stagedFile));
    try { originalCatalogProofs.push(fileProof(oldFile + '-wal',check,stagedFile + '-wal',created)); stageFiles.set(stagedFile + '-wal',admit(stagedFile + '-wal')); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    for (const proof of originalCatalogProofs) {
      const staged = fileProof(path.join(stage,path.basename(proof.filename)),check);
      if (proof.sha256 !== staged.sha256) defer('source_changed');
    }
    const recordFiles = () => { for (const suffix of ['','-wal','-shm','-journal']) {
      try { const file = stagedFile + suffix; stageFiles.set(file,admit(file)); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    } };
    source = openCatalog(stagedFile,true,recordFiles);
    recordFiles();
    destination = openCatalog(newFile,false);
    destination.exec('BEGIN IMMEDIATE'); transaction = true; source.exec('BEGIN');
    const oldState = authority(source), newState = authority(destination);
    if (newState.control?.paused !== 1) defer('destination_not_paused');
    await owners(sourceConfig,oldState,processProbe,check); await owners(destinationConfig,newState,processProbe,check);
    const oldRows = locatorRows(source,check), newRows = locatorRows(destination,check);
    if (oldRows.artifacts.length !== newRows.artifacts.length || oldRows.attempts.length !== newRows.attempts.length) defer('locator_mismatch');
    const proofs = [], artifactUpdates = [], logUpdates = [], projectionOwners = new Map();
    const mapped = (filename,directory) => {
      let oldLocator; try { oldLocator = absolute(filename); } catch { defer('locator_mismatch'); }
      const oldBase = path.join(oldRoot,directory), newBase = path.join(newRoot,directory);
      const matched = locatorRoots.filter(root=>contained(path.join(root,directory),oldLocator));
      if (matched.length !== 1) defer('locator_mismatch');
      const relative = path.relative(path.join(matched[0],directory),oldLocator);
      const oldPath = path.join(oldBase,relative), newPath = path.join(newBase,relative);
      const key = pathKey(newPath), owner = pathKey(oldLocator);
      if (projectionOwners.has(key) && projectionOwners.get(key) !== owner) defer('locator_mismatch');
      projectionOwners.set(key,owner);
      return { oldLocator, oldPath, newPath };
    };
    for (let i=0; i<oldRows.artifacts.length; i++) {
      check(); const row = oldRows.artifacts[i], copy = newRows.artifacts[i], paths = mapped(row.path,'artifacts');
      if (typeof row.schema !== 'string' || typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(row.sha256)
          || !Number.isSafeInteger(row.size_bytes) || row.size_bytes < 0
          || row.sha256 !== copy.sha256 || row.schema !== copy.schema || row.size_bytes !== copy.size_bytes
          || ![paths.oldLocator,paths.newPath].includes(path.normalize(copy.path))) defer('locator_mismatch');
      const original = fileProof(paths.oldPath,check), restored = fileProof(paths.newPath,check);
      if ([original,restored].some(p=>p.sha256 !== row.sha256 || p.bytes !== row.size_bytes)) defer('artifact_mismatch');
      proofs.push(original,restored); artifactUpdates.push([paths.newPath,row.sha256]);
    }
    let logLocators = 0;
    for (let i=0; i<oldRows.attempts.length; i++) {
      check(); const row = oldRows.attempts[i], copy = newRows.attempts[i]; if (typeof row.id !== 'string' || row.id !== copy.id) defer('locator_mismatch');
      const values = [];
      for (const column of ['stdout_path','stderr_path']) {
        if (row[column] === '') { if (copy[column] !== '') defer('locator_mismatch'); values.push(''); continue; }
        const paths = mapped(row[column],'attempts');
        if (![paths.oldLocator,paths.newPath].includes(path.normalize(copy[column]))) defer('locator_mismatch');
        const original = fileProof(paths.oldPath,check), restored = fileProof(paths.newPath,check);
        if (original.bytes !== restored.bytes || original.sha256 !== restored.sha256) defer('log_mismatch');
        proofs.push(original,restored); values.push(paths.newPath); logLocators++;
      }
      logUpdates.push([...values,row.id]);
    }
    source.exec('COMMIT');
    proofs.push(...originalCatalogProofs);
    for (const proof of proofs) {
      check(); const current = fileProof(proof.filename,check);
      if (!sameMetadata(proof.identity,current.identity) || proof.sha256 !== current.sha256) defer('source_changed');
    }
    await startup(); await owners(sourceConfig,authority(source),processProbe,check); await owners(destinationConfig,authority(destination),processProbe,check);
    historicalAbsence();
    if (JSON.stringify(locatorRows(source,check)) !== JSON.stringify(oldRows) || JSON.stringify(authority(source)) !== JSON.stringify(oldState)
        || !sameIdentity(oldIdentity,admit(oldFile)) || !sameIdentity(newIdentity,admit(newFile))) defer('source_changed');
    for (const proof of proofs) { check(); if (!sameMetadata(proof.identity,admit(proof.filename))) defer('source_changed'); }
    if (originalCatalogProofs.length === 1) {
      try { admit(oldFile + '-wal'); defer('source_changed'); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    }
    try { admit(oldFile + '-journal'); defer('source_changed'); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    const updateArtifact = destination.prepare('UPDATE artifacts SET path=? WHERE sha256=?');
    const updateLogs = destination.prepare('UPDATE attempts SET stdout_path=?,stderr_path=? WHERE id=?');
    for (const values of artifactUpdates) { check(); updateArtifact.run(...values); }
    for (const values of logUpdates) { check(); updateLogs.run(...values); }
    completion = 'unconfirmed'; destination.exec('COMMIT'); transaction = false; completion = 'confirmed';
    result = { schema: LOCATOR_ADOPTION_SCHEMA, status: 'adopted', completion, artifacts: artifactUpdates.length, logLocators,
      projectionSha256: createHash('sha256').update(JSON.stringify({artifactUpdates,logUpdates})).digest('hex') };
  } catch (error) {
    result = { schema: LOCATOR_ADOPTION_SCHEMA, status: completion === 'unconfirmed' ? 'failed' : 'deferred', completion,
      reason: error instanceof Deferred ? error.reason : 'file_unavailable' };
  } finally {
    let failed = false;
    try { if (transaction) destination.exec('ROLLBACK'); } catch { failed = true; }
    for (const db of [destination,source]) { try { db?.close(); } catch { failed = true; } }
    if (stage) {
      try {
        if (!sameIdentity(stageIdentity,admit(stage,true))) throw new Error('stage changed');
        for (const suffix of ['','-wal','-shm','-journal']) {
          const file = path.join(stage,'catalog.sqlite' + suffix); let info;
          try { info = admit(file); } catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
          const owned = stageFiles.get(file);
          if (!owned || !sameIdentity(owned,info)) throw new Error('stage file changed');
          unlinkSync(file);
        }
        rmdirSync(stage);
      } catch { failed = true; }
    }
    if (failed) result = { schema: LOCATOR_ADOPTION_SCHEMA, status: 'failed', completion, reason: 'cleanup_failed' };
  }
  return Object.freeze(result);
}
