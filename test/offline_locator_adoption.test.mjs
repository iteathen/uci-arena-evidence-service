import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, renameSync, existsSync, rmSync, symlinkSync, unlinkSync, linkSync, readdirSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Catalog } from '../src/catalog.mjs';
import { loadConfig } from '../src/config.mjs';
import { adoptOfflineLocators } from '../src/offline_locator_adoption.mjs';
const root = path.resolve(import.meta.dirname,'..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const cliTest = process.platform === 'win32' ? test : test.skip;
async function fixture(t) {
  const folder = mkdtempSync(path.join(os.tmpdir(),'evidence-offline-adoption-'));
  t.after(() => rmSync(folder,{recursive:true,force:true}));
  const source = path.join(folder,'source'), target = path.join(folder,'target');
  mkdirSync(source); const config = await loadConfig({workspace:source}); const catalog = new Catalog(config);
  catalog.setPaused(true,'operator pause before uninstall');
  const raw = Buffer.from('{"schema":"fixture","historical_path":"C:/opaque/original.exe"}\n');
  const digest = sha(raw), relative = path.join('artifacts',digest.slice(0,2),`${digest}.raw`);
  mkdirSync(path.dirname(path.join(source,relative)),{recursive:true}); writeFileSync(path.join(source,relative),raw);
  catalog.registerArtifact({sha256:digest,schema:'fixture',filename:path.join(source,relative),sizeBytes:raw.length});
  const datasetId = catalog.createDataset({campaign:'fixture',targetIdentity:{historical_path:'C:/opaque/target.exe'}});
  const job = catalog.enqueueJob({adapter:'paired_sprt',shardId:'fixture',datasetId,fingerprint:'a'.repeat(64),config:{opaque_path:'C:/opaque/config.exe'}});
  const logs = ['stdout.log','stderr.log'].map(name=>path.join(source,'attempts','fixture',name));
  mkdirSync(path.dirname(logs[0]),{recursive:true}); logs.forEach((file,i)=>writeFileSync(file,`opaque ${i}\n`));
  const attemptId = catalog.startAttempt(job.id,{stdout:logs[0],stderr:logs[1]});
  catalog.finishAttempt(attemptId,{state:'failed',reason:'fixture',resource:{original_path:'C:/opaque/resource'}});
  catalog.close(); cpSync(source,target,{recursive:true});
  return {folder,source,target,digest,relative,logs,attemptId};
}
function invoke(f,extra=[],environment={}) {
  const child = spawnSync(process.execPath,['--import',pathToFileURL(path.join(root,'test/support/offline_startup_absent.mjs')).href,
    path.join(root,'src/cli.mjs'),'workspace','adopt-locators','--source-workspace',f.source,'--workspace',f.target,...extra],
  {cwd:root,encoding:'utf8',windowsHide:true,timeout:15000,env:{...process.env,...environment}});
  return {exit:child.status,stdout:child.stdout,stderr:child.stderr,result:child.stdout.trim()?JSON.parse(child.stdout):null};
}
function edit(f,sql,...args) {const db=new DatabaseSync(path.join(f.target,'catalog.sqlite')); try {db.prepare(sql).run(...args);} finally {db.close();}}
// Independent fixture oracle preserves every other column, including opaque JSON bytes.
function durable(workspace) {
  const db=new DatabaseSync(path.join(workspace,'catalog.sqlite'),{readOnly:true});
  try {return Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(({name})=> {
    const rows=db.prepare(`SELECT * FROM "${name}"`).all().map(row=>{const r={...row}; if(name==='artifacts')delete r.path;
      if(name==='attempts'){delete r.stdout_path;delete r.stderr_path;}return r;}); return [name,rows];}));} finally {db.close();}
}
cliTest('offline adoption retargets copied raw artifacts and logs while preserving all durable bytes',async t=>{
  const f=await fixture(t), original=sha(readFileSync(path.join(f.source,'catalog.sqlite'))), before=durable(f.target);
  const called=invoke(f); assert.equal(called.exit,0,JSON.stringify(called)); assert.equal(called.result.status,'adopted');
  assert.equal(called.result.artifacts,1); assert.equal(called.result.logLocators,2); assert.equal(called.stderr,'');
  assert.equal(sha(readFileSync(path.join(f.source,'catalog.sqlite'))),original); assert.deepEqual(durable(f.target),before);
  renameSync(f.source,path.join(f.folder,'retained-source-backup'));
  const restored=new Catalog(await loadConfig({workspace:f.target}));
  try {assert.deepEqual(restored.readArtifact(f.digest),{schema:'fixture',historical_path:'C:/opaque/original.exe'});
    const row=restored.database.prepare('SELECT stdout_path,stderr_path FROM attempts WHERE id=?').get(f.attemptId);
    assert.equal(readFileSync(row.stdout_path,'utf8'),'opaque 0\n'); assert.equal(readFileSync(row.stderr_path,'utf8'),'opaque 1\n');}
  finally {restored.close();}
});
cliTest('digest mismatch rolls back every locator',async t=>{
  const f=await fixture(t),before=durable(f.target); writeFileSync(path.join(f.target,f.relative),'altered');
  const called=invoke(f);assert.equal(called.exit,2);assert.equal(called.result.reason,'artifact_mismatch'); assert.deepEqual(durable(f.target),before);
  const db=new DatabaseSync(path.join(f.target,'catalog.sqlite'));try{assert.equal(db.prepare('SELECT path FROM artifacts').get().path,path.join(f.source,f.relative));}finally{db.close();}
});
cliTest('log mismatch prevents adoption without changing other history',async t=>{
  const f=await fixture(t);writeFileSync(path.join(f.target,'attempts','fixture','stderr.log'),'different');
  const called=invoke(f);assert.equal(called.exit,2);assert.equal(called.result.reason,'log_mismatch');
});
cliTest('a destination scheduler must already be paused',async t=>{
  const f=await fixture(t);edit(f,'UPDATE control SET paused=0');const called=invoke(f);assert.equal(called.exit,2);assert.equal(called.result.reason,'destination_not_paused');
});
cliTest('external historical locators fail closed without a generic path rewrite',async t=>{
  const f=await fixture(t);edit(f,'UPDATE artifacts SET path=?',path.join(f.folder,'outside.raw'));
  const called=invoke(f);assert.equal(called.exit,2);assert.equal(called.result.reason,'locator_mismatch');
});
cliTest('missing source and invalid closed CLI grammar create no workspace',async t=>{
  const f=await fixture(t);const missing={source:path.join(f.folder,'absent'),target:path.join(f.folder,'also-absent')};
  const called=invoke(missing);assert.equal(called.exit,2);assert.equal(existsSync(missing.target),false);
  const bad=invoke(f,['--unexpected','PRIVATE_VALUE']);assert.equal(bad.exit,2);assert.equal(bad.result.reason,'invalid_request');assert.equal(bad.stderr,'');assert.equal(bad.stdout.includes('PRIVATE_VALUE'),false);
});
cliTest('copied legacy or missing daemon identity is not treated as exact absence',async t=>{
  const f=await fixture(t);edit(f,"UPDATE daemon_state SET pid=4242,phase='stopped',process_identity_json=''");
  const called=invoke(f);assert.equal(called.exit,2);assert.equal(called.result.reason,'daemon_unverifiable');
});
cliTest('an access-denied startup query never becomes verified absence or permits locator mutation',async t=>{
  const f=await fixture(t),before=readFileSync(path.join(f.target,'catalog.sqlite'));
  const result=invoke(f,[],{EVIDENCE_FIXTURE_STARTUP_DENIED:'1'});
  assert.equal(result.exit,2,JSON.stringify(result));assert.equal(result.result.reason,'startup_not_absent');
  assert.equal(result.result.completion,'not_attempted');assert.deepEqual(readFileSync(path.join(f.target,'catalog.sqlite')),before);
  assert.equal(result.stderr,'');
});
const identity={schema:'uci_arena_process_instance_identity_v1',platform:process.platform,pid:4242,
  start_token:'504911232000000001',executable_path:process.platform==='win32'?'C:/fixture/node.exe':'/fixture/node',boot_id:''};
async function adopt(f,overrides={}) {
  return adoptOfflineLocators({sourceConfig:await loadConfig({workspace:f.source}),destinationConfig:await loadConfig({workspace:f.target}),
    observeStartup:async()=>({schema:'uci_arena_evidence_startup_presence_v1',state:'absent'}),processProbe:()=>({state:'absent'}),...overrides});
}
test('an exact live or unknown daemon defers while dead and reused owners are admitted',async t=>{
  const f=await fixture(t);edit(f,'UPDATE daemon_state SET pid=?,process_identity_json=?',identity.pid,JSON.stringify(identity));
  for (const probe of [()=>({state:'present',identity}),()=>({state:'unverifiable'})]) {
    const result=await adopt(f,{processProbe:probe});assert.equal(result.reason,'daemon_unverifiable');assert.equal(result.completion,'not_attempted');
  }
  const result=await adopt(f,{processProbe:()=>({state:'present',identity:{...identity,start_token:'504911232000000002'}})});
  assert.equal(result.status,'adopted');
});
test('uninstalled startup must stay absent until publication',async t=>{
  const f=await fixture(t);let calls=0;
  const result=await adopt(f,{observeStartup:async()=>({schema:'uci_arena_evidence_startup_presence_v1',state:++calls>2?'present':'absent'})});
  assert.equal(result.reason,'startup_not_absent');assert.equal(result.completion,'not_attempted');
});
test('source and destination lock and heartbeat identities must all be absent',async t=>{
  const f=await fixture(t);writeFileSync(path.join(f.source,'locks','daemon.lock'),JSON.stringify({schema:'uci_arena_evidence_daemon_lock_v2',
    pid:identity.pid,nonce:'fixture',started_at:'2026-10-11T00:00:00Z',processIdentity:identity}));
  let result=await adopt(f,{processProbe:()=>({state:'present',identity})});assert.equal(result.reason,'daemon_unverifiable');
  unlinkSync(path.join(f.source,'locks','daemon.lock'));
  writeFileSync(path.join(f.target,'locks','daemon.heartbeat.json'),JSON.stringify({pid:identity.pid,nonce:'fixture',
    process_identity:identity,heartbeat_at:'2026-10-11T00:00:00Z'}));
  result=await adopt(f,{processProbe:()=>({state:'unverifiable'})});assert.equal(result.reason,'daemon_unverifiable');
});
test('a source log change after initial verification rolls back adoption',async t=>{
  const f=await fixture(t);let calls=0;
  const result=await adopt(f,{observeStartup:async()=>{if(++calls===3)writeFileSync(f.logs[0],'changed');return{schema:'uci_arena_evidence_startup_presence_v1',state:'absent'};}});
  assert.equal(result.reason,'source_changed');
  const db=new DatabaseSync(path.join(f.target,'catalog.sqlite'));try{assert.equal(db.prepare('SELECT path FROM artifacts').get().path,path.join(f.source,f.relative));}finally{db.close();}
});
test('source locator projection drift rejects a copied workspace',async t=>{
  const f=await fixture(t);let calls=0;
  const result=await adopt(f,{observeStartup:async()=>{if(++calls===3){const db=new DatabaseSync(path.join(f.source,'catalog.sqlite'));
    try{db.prepare('UPDATE artifacts SET schema=?').run('changed');}finally{db.close();}}return{schema:'uci_arena_evidence_startup_presence_v1',state:'absent'};}});
  assert.equal(result.reason,'source_changed');
});
test('reparse ancestors and missing copied logs fail without touching the originals',async t=>{
  const f=await fixture(t),directory=path.dirname(path.join(f.target,f.relative)),stash=path.join(f.folder,'artifact-stash');
  renameSync(directory,stash);symlinkSync(stash,directory,process.platform==='win32'?'junction':'dir');
  const result=await adopt(f);assert.equal(result.reason,'file_unavailable');
  unlinkSync(directory);renameSync(stash,directory);unlinkSync(path.join(f.target,'attempts','fixture','stderr.log'));
  assert.equal((await adopt(f)).reason,'file_unavailable');assert.equal(readFileSync(f.logs[1],'utf8'),'opaque 1\n');
});
test('a hardlinked destination catalog cannot mutate its source backup',async t=>{
  const f=await fixture(t);unlinkSync(path.join(f.target,'catalog.sqlite'));linkSync(path.join(f.source,'catalog.sqlite'),path.join(f.target,'catalog.sqlite'));
  assert.equal((await adopt(f)).reason,'invalid_request');
});
test('already adopted inventories are verified on retry and an expired bound stays closed',async t=>{
  const f=await fixture(t);assert.equal((await adopt(f)).status,'adopted');assert.equal((await adopt(f)).status,'adopted');
  const result=await adopt(f,{maximumMilliseconds:0});assert.equal(result.reason,'invalid_request');
});
test('unknown SQL trigger authority cannot rewrite historical content during locator adoption',async t=>{
  const f=await fixture(t),db=new DatabaseSync(path.join(f.target,'catalog.sqlite'));
  try{db.exec("CREATE TRIGGER unexpected_history_rewrite AFTER UPDATE OF path ON artifacts BEGIN UPDATE jobs SET config_json='{}'; END;");}finally{db.close();}
  const before=durable(f.target),result=await adopt(f);assert.equal(result.reason,'catalog_unavailable');assert.deepEqual(durable(f.target),before);
});
test('an exception or foreign-platform process response never proves daemon absence',async t=>{
  const f=await fixture(t);edit(f,'UPDATE daemon_state SET pid=?,process_identity_json=?',identity.pid,JSON.stringify(identity));
  let result=await adopt(f,{processProbe:()=>{throw new Error('PRIVATE_PROBE_ERROR');}});assert.equal(result.reason,'daemon_unverifiable');
  const foreign={...identity,platform:process.platform==='win32'?'linux':'win32',executable_path:'C:/fixture/node.exe'};
  result=await adopt(f,{processProbe:()=>({state:'present',identity:foreign})});assert.equal(result.reason,'daemon_unverifiable');
});
test('read-only source inspection creates no SQLite coordination files beside retained originals',async t=>{
  const f=await fixture(t),before=readdirSync(f.source).sort(); const result=await adopt(f);
  assert.deepEqual(readdirSync(f.source).sort(),before);assert.equal(result.status,'adopted');
  assert.equal(readdirSync(f.target).some(name=>name.startsWith('.locator-source-')),false);
});
test('timeout during bounded private copying joins exact staging cleanup',async t=>{
  const f=await fixture(t);appendFileSync(path.join(f.source,'catalog.sqlite'),Buffer.alloc(64*1024*1024));
  const result=await adopt(f,{maximumMilliseconds:30});
  assert.equal(result.status,'deferred');assert.equal(result.reason,'cancelled_or_timeout');
  assert.equal(readdirSync(f.target).some(name=>name.startsWith('.locator-source-')),false);
});
test('existing WAL state is read through a private copy without altering original DB or WAL bytes',async t=>{
  const f=await fixture(t),original=new Catalog(await loadConfig({workspace:f.source}));
  try {
    original.setPaused(true,'retained WAL-only pause');cpSync(f.source,f.target,{recursive:true});
    const file=path.join(f.source,'catalog.sqlite'),before=sha(readFileSync(file)),wal=sha(readFileSync(file+'-wal'));
    const result=await adopt(f);assert.equal(result.status,'adopted');
    assert.equal(sha(readFileSync(file)),before);assert.equal(sha(readFileSync(file+'-wal')),wal);
    assert.deepEqual(durable(f.target),durable(f.source));
  } finally {original.close();}
});
test('a retained rollback journal is not silently replayed or ignored',async t=>{
  const f=await fixture(t);writeFileSync(path.join(f.source,'catalog.sqlite-journal'),'opaque unresolved journal');
  const result=await adopt(f);assert.equal(result.reason,'catalog_unavailable');assert.equal(result.completion,'not_attempted');
});
test('a legacy installed false flag is insufficient proof for offline mutation',async t=>{
  const f=await fixture(t);assert.equal((await adopt(f,{observeStartup:async()=>({installed:false})})).reason,'startup_not_absent');
});
