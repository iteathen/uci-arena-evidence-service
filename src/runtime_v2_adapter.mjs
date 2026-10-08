import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '@uci-arena/time-profile-contract';
import { targetIdentity } from './identity.mjs';


export function runtimeV2Command(job,target,runtime,attemptDirectory) {
  if(runtime.capabilities[job.adapter]?.status !== 'available') {
    throw new Error(`evidence runtime ${job.adapter} is unsupported: ${runtime.capabilities[job.adapter]?.reason ?? 'not declared'}`);
  }
  if(!target.runtimeBinding||canonicalJson(target.runtimeBinding.identity)!==canonicalJson(runtime.identity))throw new Error('v2 target runtime binding identity drifted');
  const campaign=job.config?.campaign;const declaration=runtime.campaigns.get(campaign);
  if(!declaration||!declaration.workloads.includes(job.adapter))throw new Error('selected runtime campaign/workload is unsupported');
  const parameters=runtime.validateCampaign(campaign,job.config?.parameters??{});
  mkdirSync(attemptDirectory,{recursive:true});
  const request={schema:'uci_arena_evidence_request_v2',request_id:randomUUID(),job_id:job.id,shard_id:job.shardId,
    workload:job.adapter,target_identity:targetIdentity(target),runtime_identity:runtime.identity,
    runtime_binding:target.runtimeBinding.runtime_binding,launch:target.runtimeBinding.launch,
    campaign,config:parameters};
  const filename=path.join(attemptDirectory,'runtime-request.json');const temporary=`${filename}.${randomUUID()}.tmp`;
  writeFileSync(temporary,`${JSON.stringify(request,null,2)}\n`,{flag:'wx'});renameSync(temporary,filename);
  const output=path.join(attemptDirectory,'runtime-result.json');
  return {executable:process.execPath,args:[runtime.entrypoints[job.adapter],'--request',filename,'--output',output],workingDirectory:runtime.root,
    environment:{...process.env},outputs:[{filename:output,kind:'json'}],runtimeMajor:2,runtimeRequest:request};
}

const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const finite=v=>Number.isFinite(v)&&v>=0;
export function validateRuntimeV2Records(job,target,command,records) {
  if(records.length!==1)throw new Error('v2 runtime must produce one result');
  const record=records[0];const request=command.runtimeRequest;
  if(record?.schema!=='uci_arena_evidence_result_v2'||record.workload!==job.adapter
    ||record.request_id!==request.request_id||record.job_id!==job.id||record.shard_id!==job.shardId
    ||canonicalJson(record.target_identity)!==canonicalJson(targetIdentity(target))
    ||canonicalJson(record.runtime_identity)!==canonicalJson(request.runtime_identity))throw new Error('v2 runtime result identity is incompatible');
  if(!['completed','failed','incomplete'].includes(record.status)||record.completed!==(record.status==='completed')
    ||!Array.isArray(record.games)||record.games.length>256||!Array.isArray(record.samples)||record.samples.length>819200
    ||!Array.isArray(record.failures)||record.failures.length>256||record.failures.some(v=>typeof v!=='string'||v.length>2048)
    ||!Array.isArray(record.engine_identities)||!plain(record.qualification)
    ||record.qualification.diagnostic!==true||record.qualification.timing!==false||record.qualification.strength!==false
    ||record.qualification.profile_publication!==false)throw new Error('v2 runtime result shape or qualification is incompatible');
  for(const game of record.games) {
    if(!plain(game)||typeof game.complete!=='boolean'||typeof game.legal!=='boolean'||typeof game.termination!=='string'
      ||!Array.isArray(game.records)||game.records.length>2048||!plain(game.clocks_ms)
      ||!Number.isFinite(game.clocks_ms.white)||!Number.isFinite(game.clocks_ms.black)
      ||(game.complete&&(!game.legal||!['1-0','0-1','1/2-1/2'].includes(game.result)
        ||!['checkmate','stalemate','threefold_repetition','rule_50','insufficient_material'].includes(game.termination))))throw new Error('v2 runtime game completeness is incompatible');
    for(const move of game.records)if(!plain(move)||typeof move.move!=='string'||!finite(move.elapsed_ms)||typeof move.fen!=='string')throw new Error('v2 runtime game measurement is incompatible');
  }
  for(const sample of record.samples)if(!plain(sample)||sample.legal!==true||!finite(sample.elapsed_ms)
    ||!finite(sample.requested_ms)||sample.requested_ms===0||!finite(sample.deadline_overshoot_ms)||typeof sample.move!=='string')throw new Error('v2 runtime timing sample is incompatible');
  if(record.status==='completed' && (record.failures.length || (job.adapter==='timing_profile'? !record.samples.length : !record.games.length||record.games.some(g=>!g.complete))))throw new Error('v2 runtime completed state contradicts measurements');
  if(job.adapter==='paired_sprt'&&record.status==='completed') {
    const pairs=new Map();
    for(const game of record.games){const colors=pairs.get(game.opening_id)??[];colors.push(game.candidate_color);pairs.set(game.opening_id,colors);}
    if([...pairs.values()].some(colors=>colors.length!==2||new Set(colors).size!==2||colors.some(c=>!['white','black'].includes(c))))throw new Error('v2 runtime color pair is incomplete');
  }
  return record.status==='completed'?[]:[...(record.failures.length?record.failures:[`v2 runtime ${record.status}`])];
}
