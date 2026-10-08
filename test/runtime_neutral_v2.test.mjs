import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { validateRuntimeBinding, admitRuntimeTarget, RuntimeCapabilityUnsupported } from '../src/runtime_v2_binding.mjs';
import { adapterCommand, harvestAdapter } from '../src/adapters.mjs';
import { Catalog } from '../src/catalog.mjs';
import { loadConfig } from '../src/config.mjs';
import { registerTargetApi, enqueueCampaignApi, orchestrationStatusApi } from '../src/manager_api.mjs';
import { resolveJobTarget, targetIdentity } from '../src/identity.mjs';
import { renderInstallerConfiguration } from '../src/installer_integration.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');

export function providerFixture(t,id='different.cpu-engine',identity={schema:'different_cpu_identity_v7',build:'portable-fixture'},gpu=false) {
  const cleanups=[];const root=mkdtempSync(path.join(os.tmpdir(),'evidence-neutral-'));t.after(()=>{for(const close of cleanups)close();rmSync(root,{recursive:true,force:true});});
  const schema={type:'object',additionalProperties:false,properties:{initialTimeMs:{type:'integer',minimum:1,maximum:60000},maxPlies:{type:'integer',minimum:1,maximum:128}},required:[]};
  const contract={schema:'uci_arena_evidence_runtime_v2',component_id:id,component_version:'1.2.3',target_triple:process.platform==='win32'?'windows-x86_64':'linux-x86_64',runtime_identity:{path:'contracts/identity.json',schema:identity.schema},referee:'tools/referee.mjs',resource_requirements:{gpu},capabilities:{complete_game:{status:'available',entrypoint:'tools/evidence.mjs',request_schema:'uci_arena_evidence_request_v2',output_schema:'uci_arena_evidence_result_v2'},paired_sprt:{status:'unsupported',reason:'not implemented'},timing_profile:{status:'unsupported',reason:'not implemented'}},campaigns:[{name:'bounded-games',parameters_schema:'contracts/parameters.json',workloads:['complete_game']}]};
  const files={'bin/engine.bin':'different engine bytes','tools/evidence.mjs':'// runner','tools/referee.mjs':'// referee','contracts/identity.json':JSON.stringify(identity),'contracts/parameters.json':JSON.stringify(schema),'contracts/evidence-runtime-contract.json':JSON.stringify(contract)};
  const inventory=Object.entries(files).map(([p,bytes])=>{mkdirSync(path.dirname(path.join(root,p)),{recursive:true});writeFileSync(path.join(root,p),bytes);return{path:p,size_bytes:Buffer.byteLength(bytes),sha256:hash(bytes)};});
  const manifest={schema:'arena_install_component_v1',schema_version:1,component_id:id,component_version:'1.2.3',target_triple:contract.target_triple,capabilities:['evidence_runtime_contract_v2'],entrypoints:{evidence_runtime_contract:'contracts/evidence-runtime-contract.json'},files:inventory};
  writeFileSync(path.join(root,'arena-component.json'),JSON.stringify(manifest));
  const binding={schema:'uci_arena_evidence_runtime_binding_v2',component:{id,version:'1.2.3',root,manifest:'arena-component.json',manifest_sha256:hash(JSON.stringify(manifest))},entrypoint:'evidence_runtime_contract'};
  const input={schema:'uci_arena_evidence_target_v2',label:id,launch:{executable:path.join(root,'bin/engine.bin'),arguments:['--mode','analysis'],working_directory:root,uci_options:{Hash:16}},runtime_binding:binding};
  return{root,binding,input,manifest,contract,inventory,cleanups};
}
function replaceContract(f) {
  const bytes=JSON.stringify(f.contract);writeFileSync(path.join(f.root,'contracts/evidence-runtime-contract.json'),bytes);
  Object.assign(f.manifest.files.find(row=>row.path==='contracts/evidence-runtime-contract.json'),{sha256:hash(bytes),size_bytes:Buffer.byteLength(bytes)});
  const manifest=JSON.stringify(f.manifest);writeFileSync(path.join(f.root,'arena-component.json'),manifest);f.binding.component.manifest_sha256=hash(manifest);
}
test('unrelated CPU and Vector identities use same generic admission without product dispatch',t=>{
  for(const f of [providerFixture(t),providerFixture(t,'uci_arena.vector',{schema:'vector_engine_runtime_identity_v1',model:{checkpointSha256:'a'.repeat(64)}},true)]) {
    if(f.binding.component.id!=='uci_arena.vector'){f.input.launch.arguments=[];f.input.launch.working_directory=path.join(f.root,'bin');}
    const runtime=validateRuntimeBinding(f.binding);assert.equal(runtime.componentId,f.binding.component.id);
    const target=admitRuntimeTarget(f.input);assert.equal(target.enginePath,f.input.launch.executable);assert.notEqual(target.enginePath,runtime.contractPath);
    assert.deepEqual(target.runtimeBinding.launch,f.input.launch);assert.deepEqual(runtime.engineIdentity,JSON.parse(readFileSync(path.join(f.root,'contracts/identity.json'))));
  }
});
test('unsupported parameter schema is rejected even when hidden behind an omitted optional field',t=>{
  const f=providerFixture(t);const file=path.join(f.root,'contracts/parameters.json');const schema=JSON.parse(readFileSync(file));schema.properties.hidden={type:'string',maxLength:8,pattern:'.*'};
  const bytes=JSON.stringify(schema);writeFileSync(file,bytes);Object.assign(f.manifest.files.find(row=>row.path==='contracts/parameters.json'),{sha256:hash(bytes),size_bytes:Buffer.byteLength(bytes)});const manifest=JSON.stringify(f.manifest);writeFileSync(path.join(f.root,'arena-component.json'),manifest);f.binding.component.manifest_sha256=hash(manifest);
  assert.throws(()=>validateRuntimeBinding(f.binding),/parameter schema/);
});
test('target-specific command uses its own contract and exact registered launch; global root inert',t=>{
  const f=providerFixture(t);const other=providerFixture(t,'other.provider');const target=admitRuntimeTarget(f.input);
  const job={id:'j',shardId:'s',adapter:'complete_game',config:{campaign:'bounded-games',parameters:{initialTimeMs:1000}}};
  const command=adapterCommand(job,target,{runtimeRoot:other.root},path.join(f.root,'attempt'));
  const request=JSON.parse(readFileSync(command.args[2],'utf8'));
  assert.equal(command.args[0],path.join(f.root,'tools/evidence.mjs'));assert.deepEqual(request.launch,f.input.launch);
  assert.equal(command.workingDirectory,f.root);
  assert.equal(request.runtime_identity.component_id,f.binding.component.id);assert.equal(target.engineSha256,hash('different engine bytes'));
});
test('optional absent runtime yields typed unsupported; no engine registration fallback',()=>{
  assert.throws(()=>admitRuntimeTarget({schema:'uci_arena_evidence_target_v2',launch:{},runtime_binding:null}),e=>e instanceof RuntimeCapabilityUnsupported&&e.code==='EVIDENCE_RUNTIME_UNSUPPORTED');
});
test('inventory/manifest and exact launch drift fail before adapter mutation',t=>{
  const f=providerFixture(t);assert.throws(()=>admitRuntimeTarget({...f.input,launch:{...f.input.launch,executable:process.execPath}}),/inventory/);
  writeFileSync(path.join(f.root,'tools/evidence.mjs'),'changed');assert.throws(()=>validateRuntimeBinding(f.binding),/inventory/);
  const g=providerFixture(t);g.binding.component.id='substitute';assert.throws(()=>validateRuntimeBinding(g.binding),/identity/);
});
test('advertised campaign schema admits bounds and rejects unknown paths/raw fields',t=>{
  const f=providerFixture(t);const runtime=validateRuntimeBinding(f.binding);
  assert.deepEqual(runtime.validateCampaign('bounded-games',{maxPlies:12}),{maxPlies:12});
  assert.throws(()=>runtime.validateCampaign('bounded-games',{enginePath:'arbitrary'}),/unknown/);
  assert.throws(()=>runtime.validateCampaign('bounded-games',{maxPlies:1000}),/range/);
  assert.throws(()=>runtime.validateCampaign('undeclared',{}),/unsupported/);
});
test('target-specific binding survives catalog reopen and campaigns obey selected provider',async t=>{
  const f=providerFixture(t);const config=await loadConfig({workspace:path.join(f.root,'state')});let catalog=new Catalog(config);
  f.cleanups.push(()=>catalog.close());
  const response=registerTargetApi(catalog,f.input);
  assert.equal(response.payload.status,'supported');const id=response.payload.target.id;
  assert.equal(response.payload.target.component_id,f.binding.component.id);
  assert.equal(response.payload.target.campaigns[0].name,'bounded-games');
  assert.equal(registerTargetApi(catalog,f.input).payload.created,false);
  catalog.close();catalog=new Catalog(config);const target=catalog.target(id);
  assert.equal(target.runtimeBinding.runtime_binding.component.id,f.binding.component.id);
  assert.deepEqual(target.runtimeBinding.launch,f.input.launch);
  const queued=enqueueCampaignApi(catalog,id,{campaign:'bounded-games',configuration:{maxPlies:20}});
  assert.equal(queued.payload.jobs.length,1);assert.equal(catalog.jobs()[0].adapter,'complete_game');
  assert.deepEqual(catalog.jobs()[0].config,{campaign:'bounded-games',parameters:{maxPlies:20}});
  assert.throws(()=>enqueueCampaignApi(catalog,id,{campaign:'wrong',configuration:{}}),/unsupported/);
  assert.equal(resolveJobTarget({targetId:id},catalog,config).target.id,id);
  assert.equal(orchestrationStatusApi(catalog).payload.targets[0].target_schema,'uci_arena_evidence_target_v2');
});
test('unsupported engine capability stays a typed optional service result with no target mutation',()=>{
  let mutated=false;const result=registerTargetApi({addTarget(){mutated=true;}},{schema:'uci_arena_evidence_target_v2',label:'ordinary UCI',launch:{},runtime_binding:null});
  assert.equal(result.payload.status,'unsupported');assert.equal(result.payload.code,'EVIDENCE_RUNTIME_UNSUPPORTED');assert.equal(mutated,false);
});
test('existing v1 installer context binds unrelated managed engine without model/provider inference',t=>{
  const f=providerFixture(t);const profile={schema:'arena_uci_engine_launch_profile_v1',schema_version:1,component:{id:f.manifest.component_id,version:f.manifest.component_version,root:'.'},engine:{adapter:'standard_uci_v1',executable:'bin/engine.bin',arguments:['--mode','analysis'],working_directory:'.'},enabled:true,state:'conservative',expected_runtime:null,uci_options:{Hash:16}};
  const file=path.join(f.root,'contracts/launch-profile.json');writeFileSync(file,JSON.stringify(profile));
  f.manifest.files.push({path:'contracts/launch-profile.json',size_bytes:Buffer.byteLength(JSON.stringify(profile)),sha256:hash(JSON.stringify(profile))});
  writeFileSync(path.join(f.root,'arena-component.json'),JSON.stringify(f.manifest));
  const result=renderInstallerConfiguration({schema:'arena_provider_install_context_v1',schema_version:1,workspace:path.join(f.root,'state'),bindings:{evidence_runtime_root:f.root,engine_component_manifest:path.join(f.root,'arena-component.json'),engine_launch_profile:file}});
  const pointer=result.generated_documents[0].document;
  assert.equal(pointer.schema,'arena_installed_active_evidence_target_v2');assert.equal(pointer.target.launch.executable,f.input.launch.executable);
  assert.equal(pointer.target.runtime_binding.component.id,f.manifest.component_id);assert.equal(pointer.target.model_fingerprint,undefined);
  assert.equal(result.configuration.engine,f.input.launch.executable);assert.equal(result.configuration.runtimeRoot,undefined);
});
test('unknown runtime major, private-path reference and missing optional capability fail explicitly',t=>{
  const f=providerFixture(t);f.contract.schema='uci_arena_evidence_runtime_v99';replaceContract(f);assert.throws(()=>validateRuntimeBinding(f.binding),/major/);
  const g=providerFixture(t);g.contract.capabilities.complete_game.entrypoint='../private/source.mjs';replaceContract(g);assert.throws(()=>validateRuntimeBinding(g.binding),/inventory/);
  const h=providerFixture(t);h.manifest.capabilities=[];const bytes=JSON.stringify(h.manifest);writeFileSync(path.join(h.root,'arena-component.json'),bytes);h.binding.component.manifest_sha256=hash(bytes);
  assert.throws(()=>validateRuntimeBinding(h.binding),error=>error.code==='EVIDENCE_RUNTIME_UNSUPPORTED');
});
test('v2 harvest retains incomplete diagnostics and revalidates target inventory',t=>{
  const f=providerFixture(t);const target=admitRuntimeTarget(f.input);const runtime=validateRuntimeBinding(f.binding);
  const job={id:'j',datasetId:'d',shardId:'s',adapter:'complete_game',config:{campaign:'bounded-games',parameters:{}}};
  const config={runtimeRoot:'unused-global-root',paths:{artifacts:path.join(f.root,'artifacts')}};
  const command=adapterCommand(job,target,config,path.join(f.root,'attempt'));const request=JSON.parse(readFileSync(command.args[2]));
  const record={schema:'uci_arena_evidence_result_v2',request_id:request.request_id,job_id:'j',shard_id:'s',workload:'complete_game',target_identity:targetIdentity(target),runtime_identity:runtime.identity,status:'incomplete',completed:false,games:[{complete:false,legal:true,result:null,termination:'max_plies',records:[],clocks_ms:{white:1,black:1}}],samples:[],engine_identities:[],failures:[],qualification:{diagnostic:true,timing:false,strength:false,profile_publication:false}};
  const save=()=>writeFileSync(command.outputs[0].filename,JSON.stringify(record));save();
  const catalog={registerArtifact(){},addObservation(){}};const result=harvestAdapter(job,target,command,config,catalog,{interval_status:'finalized',performance_authority:true});
  assert.equal(result.envelopes[0].authority.timing,false);assert.equal(result.envelopes[0].outcome.status,'incomplete');
  record.runtime_identity={...runtime.identity,component_id:'impostor'};save();assert.throws(()=>harvestAdapter(job,target,command,config,catalog,{}),/identity/);
  record.runtime_identity=runtime.identity;save();writeFileSync(path.join(f.root,'tools/referee.mjs'),'drift');assert.throws(()=>harvestAdapter(job,target,command,config,catalog,{}),/inventory/);
});
test('binding JSON corruption is visible and catalog2 migration keeps legacy target meaning',async t=>{
  const f=providerFixture(t);const config=await loadConfig({workspace:path.join(f.root,'state')});let catalog=new Catalog(config);f.cleanups.push(()=>catalog.close());
  const id=registerTargetApi(catalog,f.input).payload.target.id;
  catalog.database.prepare('UPDATE targets SET runtime_binding_json=? WHERE id=?').run('{bad',id);
  assert.throws(()=>catalog.target(id),error=>error.code==='EVIDENCE_CATALOG_CORRUPT'&&error.domain==='target_runtime_binding');
  catalog.database.prepare('UPDATE targets SET runtime_binding_json=NULL WHERE id=?').run(id);catalog.database.prepare("UPDATE metadata SET value='2' WHERE key='schema_version'").run();
  catalog.close();catalog=new Catalog(config);assert.equal(catalog.target(id).runtimeBinding,undefined);
  assert.equal(catalog.database.prepare("SELECT value FROM metadata WHERE key='schema_version'").get().value,'3');
});
test('public CLI receives bounded exact target JSON and advertises provider campaign',t=>{
  const f=providerFixture(t);const workspace=path.join(f.root,'cli-state');
  const cli=path.resolve('src/cli.mjs');
  const response=JSON.parse(execFileSync(process.execPath,[cli,'api','target','register','--workspace',workspace,'--target-json',JSON.stringify(f.input)],{encoding:'utf8',windowsHide:true}));
  assert.equal(response.payload.status,'supported');assert.equal(response.payload.target.component_id,'different.cpu-engine');
  const queued=JSON.parse(execFileSync(process.execPath,[cli,'api','campaign','enqueue','--workspace',workspace,'--target',response.payload.target.id,'--campaign','bounded-games','--configuration-json','{"maxPlies":8}'],{encoding:'utf8',windowsHide:true}));
  assert.equal(queued.payload.jobs.length,1);assert.equal(queued.payload.campaign,'bounded-games');
  const tooLarge={...f.input,label:'x'.repeat(8193)};
  assert.throws(()=>execFileSync(process.execPath,[cli,'api','target','register','--workspace',workspace,'--target-json',JSON.stringify(tooLarge)],{encoding:'utf8',windowsHide:true,stdio:['pipe','pipe','pipe']}),error=>String(error.stderr).includes('8192-byte'));
});
test('optional engine disappearance preserves historical projection and healthy service',async t=>{
  const f=providerFixture(t);const config=await loadConfig({workspace:path.join(f.root,'state')});const catalog=new Catalog(config);f.cleanups.push(()=>catalog.close());
  const id=registerTargetApi(catalog,f.input).payload.target.id;
  unlinkSync(path.join(f.root,'bin/engine.bin'));
  const projected=orchestrationStatusApi(catalog).payload.targets[0];assert.equal(projected.id,id);assert.equal(projected.identity_scope,'registered_snapshot');
  assert.equal(resolveJobTarget({targetId:id},catalog,config).target,null);assert.equal(catalog.status().daemon.active,false);
});
