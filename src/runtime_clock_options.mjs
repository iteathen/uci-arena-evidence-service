const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const optionName=/^[A-Za-z0-9 _-]{1,128}$/u;
export function uciOptionRepresentation(value){
 if(!['string','number','boolean'].includes(typeof value)||(typeof value==='number'&&!Number.isSafeInteger(value))
  ||String(value).length>512||/[\u0000-\u001f\u007f]/u.test(String(value)))throw Error('clock baseline UCI scalar is incompatible');
 return String(value);
}
export function admitClockOptionBindings(value,baseline){
 if(value===undefined)return undefined;
 if(!plain(value)||Object.keys(value).sort().join(',')!=='bindings,schema,schema_version'
  ||value.schema!=='arena_uci_clock_option_bindings_v1'||value.schema_version!==1||!plain(value.bindings)||!plain(baseline))throw Error('clock option declaration is incompatible');
 const entries=Object.entries(value.bindings);
 if(entries.length<1||entries.length>2)throw Error('clock option declaration exceeds bounds');
 for(const [name,source]of entries){
  if(!optionName.test(name)||!['initial_ms','increment_ms'].includes(source)||!Object.hasOwn(baseline,name))throw Error('clock option name/source/baseline is incompatible');
  uciOptionRepresentation(baseline[name]);
 }
 return Object.freeze({schema:value.schema,schema_version:1,bindings:Object.freeze({...value.bindings})});
}
export function bindCampaignClockOptions(declaration,baseline,parameters){
 if(declaration===undefined)return structuredClone(parameters);
 const admitted=admitClockOptionBindings(declaration,baseline),entries=[];
 for(const [name,source]of Object.entries(admitted.bindings)){
  const key=source==='initial_ms'?'initialTimeMs':'incrementMs',value=parameters[key];
  if(!Object.hasOwn(parameters,key)||!Number.isSafeInteger(value)||value<(source==='initial_ms'?1:0))throw Error('campaign original clock is missing or incompatible');
  entries.push([name,value]);
 }
 const mapped=Object.fromEntries(entries);
 const result=structuredClone(parameters);
 for(const role of ['candidateOptions','controlOptions']){
  const supplied=Object.hasOwn(parameters,role)?parameters[role]:{};
  if(!plain(supplied))throw Error('campaign role options are incompatible');
  for(const [name,value]of Object.entries(mapped))if(Object.hasOwn(supplied,name)&&uciOptionRepresentation(supplied[name])!==String(value))throw Error('campaign role clock conflicts with original control');
  result[role]={...supplied,...mapped};
 }
 return result;
}
