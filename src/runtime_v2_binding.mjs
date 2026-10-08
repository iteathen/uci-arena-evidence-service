import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, openSync, readSync, closeSync, realpathSync } from 'node:fs';
import path from 'node:path';

export class RuntimeCapabilityUnsupported extends Error {
  constructor(message='selected engine has no optional evidence runtime capability') {super(message);this.code='EVIDENCE_RUNTIME_UNSUPPORTED';}
}
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const sha=v=>typeof v==='string'&&/^[a-f0-9]{64}$/u.test(v);
const digest=b=>createHash('sha256').update(b).digest('hex');
function exact(value,keys,label) {
  if(!plain(value)||Object.keys(value).sort().join(',')!==[...keys].sort().join(','))throw new Error(`${label} shape is incompatible`);
}
function fileHash(file) {
  const fd=openSync(file,'r');const b=Buffer.allocUnsafe(65536);const h=createHash('sha256');
  try{let n;while((n=readSync(fd,b,0,b.length,null))>0)h.update(b.subarray(0,n));return h.digest('hex');}finally{closeSync(fd);}
}
function checkedPathIdentity(filename, directory=false) {
  const absolute=path.resolve(filename);
  let cursor=path.parse(absolute).root;
  for(const part of path.relative(cursor,absolute).split(path.sep).filter(Boolean)) {
    cursor=path.join(cursor,part);
    if(lstatSync(cursor).isSymbolicLink())throw new Error('registered path symlink/reparse point is forbidden');
  }
  const status=lstatSync(absolute);
  if(directory?!status.isDirectory():!status.isFile())throw new Error('registered path has wrong kind');
  const physical=realpathSync.native(absolute);
  return process.platform==='win32'?physical.toLowerCase():physical;
}
function regular(root,relative) {
  if(typeof relative!=='string'||!relative||relative.includes('\\')||/[:\u0000-\u001f]/u.test(relative)||path.isAbsolute(relative)
    ||path.posix.normalize(relative)!==relative||relative==='.'||relative.startsWith('../')||relative.split('/').some(p=>/[. ]$/u.test(p)))throw new Error('unsafe inventory path');
  const file=path.resolve(root,...relative.split('/'));
  if(!file.startsWith(`${root}${path.sep}`))throw new Error('escaping inventory path');
  let cursor=path.parse(file).root;
  for(const part of path.relative(cursor,file).split(path.sep)){cursor=path.join(cursor,part);if(lstatSync(cursor).isSymbolicLink())throw new Error('inventory symlink/reparse point is forbidden');}
  if(!lstatSync(file).isFile())throw new Error('inventory requires a regular file');return file;
}
function json(file,max=1048576) {
  if(lstatSync(file).size>max)throw new Error('contract JSON exceeds byte bound');
  const value=JSON.parse(readFileSync(file,'utf8'));if(!plain(value))throw new Error('contract JSON must be an object');return value;
}

// Closed structural JSON-schema subset. No executable keywords, regex, refs or
// unbounded forms; every provider schema is checked before validating values.
export function validateParameterSchema(schema) {
  let visits=0;const allowed=new Set(['$schema','$id','title','description','type','properties','required','additionalProperties','maxProperties','items','minItems','maxItems','minLength','maxLength','minimum','maximum','enum','const']);
  function inspect(s,depth=0) {
    if(++visits>10000||depth>16||!plain(s)||Object.keys(s).some(k=>!allowed.has(k)))throw new Error('unsupported/unbounded parameter schema');
    const types=Array.isArray(s.type)?s.type:[s.type];
    if(!types.length||new Set(types).size!==types.length||types.some(t=>!['object','array','string','integer','number','boolean','null'].includes(t)))throw new Error('unsupported parameter type');
    if(types.includes('object')){if(!plain(s.properties)||!Array.isArray(s.required)||s.required.some(k=>typeof k!=='string'||!Object.hasOwn(s.properties,k))||(s.additionalProperties!==false&&!plain(s.additionalProperties))
      ||(s.maxProperties!==undefined&&(!Number.isSafeInteger(s.maxProperties)||s.maxProperties<0||s.maxProperties>128)))throw new Error('object parameter schema is not closed/bounded');for(const child of Object.values(s.properties))inspect(child,depth+1);if(plain(s.additionalProperties))inspect(s.additionalProperties,depth+1);}
    if(types.includes('array')){if(!Number.isSafeInteger(s.maxItems)||s.maxItems<0||s.maxItems>4096||!plain(s.items)||s.minItems!==undefined&&(!Number.isSafeInteger(s.minItems)||s.minItems<0||s.minItems>s.maxItems))throw new Error('array parameter schema is unbounded');inspect(s.items,depth+1);}
    if(types.includes('string')&&(!Number.isSafeInteger(s.maxLength)||s.maxLength<0||s.maxLength>65536||s.minLength!==undefined&&(!Number.isSafeInteger(s.minLength)||s.minLength<0||s.minLength>s.maxLength)))throw new Error('string parameter schema is unbounded');
    if((types.includes('integer')||types.includes('number'))&&(!Number.isFinite(s.minimum)||!Number.isFinite(s.maximum)||s.minimum>s.maximum))throw new Error('numeric parameter schema is unbounded');
    if(s.enum!==undefined&&(!Array.isArray(s.enum)||!s.enum.length||s.enum.length>128))throw new Error('parameter enum is invalid');
  }
  inspect(schema);return schema;
}
export function validateParameters(schema,value) {
  validateParameterSchema(schema);
  let visits=0;
  function walk(s,v,depth=0) {
    if(++visits>10000||depth>16||!plain(s))throw new Error('parameter schema/value exceeds bounds');
    const allowed=new Set(['$schema','$id','title','description','type','properties','required','additionalProperties','maxProperties','items','minItems','maxItems','minLength','maxLength','minimum','maximum','enum','const']);
    if(Object.keys(s).some(k=>!allowed.has(k)))throw new Error('unsupported parameter schema keyword');
    if(s.const!==undefined&&JSON.stringify(v)!==JSON.stringify(s.const))throw new Error('parameter const differs');
    if(s.enum!==undefined&&(!Array.isArray(s.enum)||s.enum.length<1||s.enum.length>128||!s.enum.some(e=>JSON.stringify(e)===JSON.stringify(v))))throw new Error('parameter enum differs');
    const types=Array.isArray(s.type)?s.type:[s.type];
    if(types.some(t=>!['object','array','string','integer','number','boolean','null'].includes(t)))throw new Error('unsupported parameter type');
    const matches=t=>t==='object'?plain(v):t==='array'?Array.isArray(v):t==='integer'?Number.isSafeInteger(v):t==='number'?Number.isFinite(v):t==='null'?v===null:typeof v===t;
    const type=types.find(matches);if(!type)throw new Error('parameter type differs');
    if(type==='object') {
      if(!plain(s.properties)||!Array.isArray(s.required)||s.required.some(k=>!Object.hasOwn(s.properties,k))
        ||(s.additionalProperties!==false&&!plain(s.additionalProperties)))throw new Error('object parameter schema is not closed/bounded');
      if(Object.keys(v).length>(s.maxProperties??128))throw new Error('parameter object exceeds bound');
      for(const k of s.required)if(!Object.hasOwn(v,k))throw new Error('required parameter missing');
      for(const [k,item]of Object.entries(v)){if(k.length>256||/[\u0000-\u001f]/u.test(k))throw new Error('parameter key is invalid');const child=s.properties[k]??s.additionalProperties;if(child===false)throw new Error('unknown parameter field');walk(child,item,depth+1);}
    } else if(type==='array') {
      if(!Number.isSafeInteger(s.maxItems)||s.maxItems<0||s.maxItems>4096||!plain(s.items))throw new Error('array parameter schema is unbounded');
      if(v.length<(s.minItems??0)||v.length>s.maxItems)throw new Error('array parameter range differs');for(const item of v)walk(s.items,item,depth+1);
    } else if(type==='string') {
      if(!Number.isSafeInteger(s.maxLength)||s.maxLength<0||s.maxLength>65536)throw new Error('string parameter schema is unbounded');
      if(v.length<(s.minLength??0)||v.length>s.maxLength||/[\u0000]/u.test(v))throw new Error('string parameter range differs');
    } else if(type==='integer'||type==='number') {
      if(!Number.isFinite(s.minimum)||!Number.isFinite(s.maximum)||s.minimum>s.maximum||v<s.minimum||v>s.maximum)throw new Error('numeric parameter range differs');
    }
  }
  if(Buffer.byteLength(JSON.stringify(value)??'')>8192)throw new Error('parameter bytes exceed 8192-byte CLI bound');walk(schema,value);return structuredClone(value);
}

export function validateRuntimeBinding(binding) {
  if(binding===null||binding===undefined)throw new RuntimeCapabilityUnsupported();
  exact(binding,['schema','component','entrypoint'],'runtime binding');
  if(binding.schema!=='uci_arena_evidence_runtime_binding_v2')throw new Error('runtime binding major is incompatible');
  exact(binding.component,['id','version','root','manifest','manifest_sha256'],'runtime component binding');
  const c=binding.component;
  if(typeof c.id!=='string'||!/^[A-Za-z0-9_.-]{1,128}$/u.test(c.id)||typeof c.version!=='string'||!/^\d+\.\d+\.\d+(?:[-.][A-Za-z0-9.-]+)?$/u.test(c.version)||!sha(c.manifest_sha256)||typeof c.root!=='string'||!path.isAbsolute(c.root))throw new Error('runtime component identity is incompatible');
  const root=path.resolve(c.root);const manifestPath=regular(root,c.manifest);
  if(fileHash(manifestPath)!==c.manifest_sha256)throw new Error('component manifest identity drifted');
  const manifest=json(manifestPath,33554432);
  const triple=process.platform==='win32'?'windows-x86_64':'linux-x86_64';
  if(manifest.schema!=='arena_install_component_v1'||manifest.schema_version!==1||manifest.component_id!==c.id||manifest.component_version!==c.version||manifest.target_triple!==triple)throw new Error('selected component identity is incompatible');
  if(!Array.isArray(manifest.capabilities)||!manifest.capabilities.includes('evidence_runtime_contract_v2'))throw new RuntimeCapabilityUnsupported();
  if(binding.entrypoint!=='evidence_runtime_contract'||typeof manifest.entrypoints?.[binding.entrypoint]!=='string')throw new Error('runtime capability locator differs from selected component');
  const contractRelative=manifest.entrypoints[binding.entrypoint];
  if(!Array.isArray(manifest.files)||manifest.files.length<1||manifest.files.length>100000)throw new Error('component inventory is invalid');
  const files=new Map();const aliases=new Set();
  for(const row of manifest.files) {
    if(!plain(row)||typeof row.path!=='string'||!sha(row.sha256)||!Number.isSafeInteger(row.size_bytes)||row.size_bytes<0||aliases.has(row.path.toLowerCase()))throw new Error('component inventory identity is invalid');
    const file=regular(root,row.path);if(lstatSync(file).size!==row.size_bytes||fileHash(file)!==row.sha256)throw new Error('component inventory drifted');files.set(row.path,file);aliases.add(row.path.toLowerCase());
  }
  const inventoried=relative=>{if(!files.has(relative))throw new Error('runtime referenced file is absent from component inventory');return files.get(relative);};
  const contractPath=inventoried(contractRelative);const contract=json(contractPath);
  exact(contract,['schema','component_id','component_version','target_triple','runtime_identity','referee','resource_requirements','capabilities','campaigns'],'runtime contract');
  if(contract.schema!=='uci_arena_evidence_runtime_v2'||contract.component_id!==c.id||contract.component_version!==c.version||contract.target_triple!==triple)throw new Error('runtime contract identity/major is incompatible');
  exact(contract.runtime_identity,['path','schema'],'runtime identity locator');
  const identityPath=inventoried(contract.runtime_identity.path);const engineIdentity=json(identityPath);
  if(typeof contract.runtime_identity.schema!=='string'||!contract.runtime_identity.schema||engineIdentity.schema!==contract.runtime_identity.schema)throw new Error('opaque runtime identity schema differs');
  exact(contract.resource_requirements,['gpu'],'resource requirements');if(typeof contract.resource_requirements.gpu!=='boolean')throw new Error('resource requirements are invalid');
  const referee=inventoried(contract.referee);if(!contract.referee.endsWith('.mjs'))throw new Error('JS runtime referee must be inventoried');
  exact(contract.capabilities,['complete_game','paired_sprt','timing_profile'],'runtime capabilities');const entrypoints={referee};
  for(const [name,cap]of Object.entries(contract.capabilities)) {
    if(cap?.status==='unsupported'){exact(cap,['status','reason'],'unsupported capability');if(typeof cap.reason!=='string'||!cap.reason.trim()||cap.reason.length>1024)throw new Error('unsupported capability reason is missing');}
    else if(cap?.status==='available'){exact(cap,['status','entrypoint','request_schema','output_schema'],'available capability');if(cap.request_schema!=='uci_arena_evidence_request_v2'||cap.output_schema!=='uci_arena_evidence_result_v2'||typeof cap.entrypoint!=='string'||!cap.entrypoint.endsWith('.mjs'))throw new Error('runtime CLI schema is incompatible');entrypoints[name]=inventoried(cap.entrypoint);}
    else throw new Error('runtime capability status is incompatible');
  }
  if(!Array.isArray(contract.campaigns)||contract.campaigns.length<1||contract.campaigns.length>32)throw new Error('runtime campaigns are invalid');
  const campaigns=new Map();
  for(const campaign of contract.campaigns){exact(campaign,['name','parameters_schema','workloads'],'runtime campaign');if(typeof campaign.name!=='string'||!/^[A-Za-z0-9_.-]{1,128}$/u.test(campaign.name)||campaigns.has(campaign.name)||!Array.isArray(campaign.workloads)||!campaign.workloads.length||campaign.workloads.length>3||new Set(campaign.workloads).size!==campaign.workloads.length||campaign.workloads.some(w=>contract.capabilities[w]?.status!=='available'))throw new Error('runtime campaign is incompatible');const schema=validateParameterSchema(json(inventoried(campaign.parameters_schema),65536));campaigns.set(campaign.name,{...campaign,schema});}
  const identity={component_id:c.id,component_version:c.version,target_triple:triple,manifest_sha256:c.manifest_sha256,contract_sha256:fileHash(contractPath),runtime_identity_sha256:fileHash(identityPath)};
  return {major:2,root,componentId:c.id,componentVersion:c.version,contractPath,entrypoints,capabilities:contract.capabilities,engineIdentity,resourceRequirements:contract.resource_requirements,campaigns,identity,files,
    validateCampaign(name,parameters){const campaign=campaigns.get(name);if(!campaign)throw new RuntimeCapabilityUnsupported('selected campaign is unsupported');return validateParameters(campaign.schema,parameters);}};
}

export function admitRuntimeTarget(input) {
  if(input?.runtime_binding===null||input?.runtime_binding===undefined)throw new RuntimeCapabilityUnsupported();
  exact(input,['schema','label','launch','runtime_binding'],'runtime target');if(input.schema!=='uci_arena_evidence_target_v2')throw new Error('target major is incompatible');
  const runtime=validateRuntimeBinding(input.runtime_binding);exact(input.launch,['executable','arguments','working_directory','uci_options'],'registered UCI launch');
  const launch=input.launch;
  const cwd=typeof launch.working_directory==='string'?path.resolve(launch.working_directory):null;
  const rootIdentity=checkedPathIdentity(runtime.root,true);
  const cwdIdentity=cwd&&checkedPathIdentity(cwd,true);
  const executableIdentity=typeof launch.executable==='string'&&path.isAbsolute(launch.executable)
    ?checkedPathIdentity(launch.executable):null;
  const cwdContained=cwdIdentity&&(cwdIdentity===rootIdentity||cwdIdentity.startsWith(`${rootIdentity}${path.sep}`));
  if(typeof input.label!=='string'||!input.label.length||input.label.length>256||/[\u0000-\u001f]/u.test(input.label)
    ||typeof launch.executable!=='string'||!path.isAbsolute(launch.executable)
    ||![...runtime.files.values()].some(file=>checkedPathIdentity(file)===executableIdentity)
    ||typeof launch.working_directory!=='string'||!path.isAbsolute(launch.working_directory)||!cwdContained
    ||!Array.isArray(launch.arguments)||launch.arguments.length>64||launch.arguments.some(a=>typeof a!=='string'||a.length>4096||/[\u0000-\u001f]/u.test(a))
    ||!plain(launch.uci_options)||Object.keys(launch.uci_options).length>128)throw new Error('registered launch is outside component inventory/bounds');
  for(const [name,value]of Object.entries(launch.uci_options))if(!/^[A-Za-z][A-Za-z0-9 _-]{0,127}$/u.test(name)||!['string','boolean','number'].includes(typeof value)||String(value).length>512||/[\u0000-\u001f]/u.test(String(value))||(typeof value==='number'&&!Number.isSafeInteger(value)))throw new Error('registered UCI option is invalid');
  const normalized={...structuredClone(input),launch:{...structuredClone(launch),executable:path.resolve(launch.executable),working_directory:path.resolve(launch.working_directory)}};
  const projection={component_id:runtime.componentId,component_version:runtime.componentVersion,runtime_identity_sha256:runtime.identity.runtime_identity_sha256,
    capabilities:Object.entries(runtime.capabilities).map(([name,capability])=>({name,status:capability.status,...(capability.reason?{reason:capability.reason}:{})})),
    campaigns:[...runtime.campaigns.values()].map(campaign=>({name:campaign.name,workloads:campaign.workloads,parameters_schema:campaign.schema}))};
  if(Buffer.byteLength(JSON.stringify(projection))>65536)throw new Error('registered runtime projection exceeds public response bound');
  return {label:input.label,enginePath:normalized.launch.executable,engineSha256:fileHash(normalized.launch.executable),uciOptions:normalized.launch.uci_options,
    modelId:'',modelRoot:'',modelFingerprint:'',provider:'',hardwareDriverFingerprint:'',
    runtimeBinding:{...normalized,identity:runtime.identity,projection}};
}
