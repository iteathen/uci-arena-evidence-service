import assert from 'node:assert/strict';
import test from 'node:test';
import {admitClockOptionBindings,bindCampaignClockOptions} from '../src/runtime_clock_options.mjs';
const declaration={schema:'arena_uci_clock_option_bindings_v1',schema_version:1,bindings:{OriginalTime:'initial_ms',OriginalIncrement:'increment_ms'}};
const baseline={OriginalTime:0,OriginalIncrement:0,Hash:16};
test('campaign owns explicit original control; target baseline and caller role options remain unchanged',()=>{
 const accepted=admitClockOptionBindings(declaration,baseline),parameters={initialTimeMs:180000,incrementMs:0,candidateOptions:{Hash:32}};
 const before=structuredClone(parameters),out=bindCampaignClockOptions(accepted,baseline,parameters);
 assert.deepEqual(out.candidateOptions,{Hash:32,OriginalTime:180000,OriginalIncrement:0});assert.deepEqual(out.controlOptions,{OriginalTime:180000,OriginalIncrement:0});
 assert.deepEqual(parameters,before);assert.equal(baseline.OriginalTime,0);
 assert.deepEqual(bindCampaignClockOptions(undefined,baseline,parameters),parameters);
});
test('clock declaration rejects unknown fields/units/names/baselines and absent original campaign facts',()=>{
 for(const value of [null,[],{...declaration,extra:true},{...declaration,schema_version:2},{...declaration,bindings:{}},
  {...declaration,bindings:{Missing:'initial_ms'}},{...declaration,bindings:{OriginalTime:'remaining_ms'}},{...declaration,bindings:{'Original\nTime':'initial_ms'}}])
  assert.throws(()=>admitClockOptionBindings(value,baseline));
 assert.doesNotThrow(()=>admitClockOptionBindings(declaration,{...baseline,OriginalTime:'0'}));
 const accepted=admitClockOptionBindings(declaration,baseline);
 for(const parameters of [{},{initialTimeMs:180000},{initialTimeMs:0,incrementMs:0},{initialTimeMs:180000,incrementMs:'0'},
  {initialTimeMs:180000,incrementMs:0,candidateOptions:{OriginalTime:50000}},{initialTimeMs:180000,incrementMs:0,controlOptions:{OriginalIncrement:1}}])
  assert.throws(()=>bindCampaignClockOptions(accepted,baseline,parameters));
 assert.doesNotThrow(()=>bindCampaignClockOptions(accepted,baseline,{initialTimeMs:180000,incrementMs:0,candidateOptions:{OriginalTime:180000}}));
});
test('baseline uses safe bounded UCI scalar representation without granting original clock truth',()=>{
 for(const value of ['0',false,'unknown'])assert.doesNotThrow(()=>admitClockOptionBindings(declaration,{...baseline,OriginalTime:value}));
 for(const value of [null,{},[],NaN,1.5,'bad\nvalue','x'.repeat(513)])assert.throws(()=>admitClockOptionBindings(declaration,{...baseline,OriginalTime:value}));
 const accepted=admitClockOptionBindings(declaration,{...baseline,OriginalTime:'0'});
 const out=bindCampaignClockOptions(accepted,baseline,{initialTimeMs:180000,incrementMs:0,candidateOptions:{OriginalTime:'180000',OriginalIncrement:'0'}});
 assert.equal(out.candidateOptions.OriginalTime,180000);
 assert.throws(()=>bindCampaignClockOptions(accepted,baseline,{initialTimeMs:180000,incrementMs:0,candidateOptions:{OriginalTime:'0180000'}}));
});
test('bounded public names are safe dictionary keys, including leading digits and prototype spelling',()=>{
 const bindings=JSON.parse('{"schema":"arena_uci_clock_option_bindings_v1","schema_version":1,"bindings":{"__proto__":"initial_ms","1 Clock":"increment_ms"}}'),values=JSON.parse('{"__proto__":0,"1 Clock":0}');
 const out=bindCampaignClockOptions(admitClockOptionBindings(bindings,values),values,{initialTimeMs:1000,incrementMs:2});
 assert.equal(Object.hasOwn(out.candidateOptions,'__proto__'),true);assert.equal(out.candidateOptions.__proto__,1000);assert.equal(out.controlOptions['1 Clock'],2);
 assert.throws(()=>bindCampaignClockOptions(admitClockOptionBindings(declaration,baseline),baseline,{initialTimeMs:1000,incrementMs:0,candidateOptions:null}));
});
