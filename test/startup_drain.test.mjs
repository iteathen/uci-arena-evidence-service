import assert from 'node:assert/strict';
import test from 'node:test';
import * as startup from '../src/platform_startup.mjs';
const identity={schema:'uci_arena_process_instance_identity_v1',platform:'win32',pid:42,
 start_token:'639120000000000000',executable_path:'C:\\provider\\node.exe',boot_id:''};
test('owned Windows startup drain admits delayed teardown while keeping each native query within two seconds',async()=>{
 assert.equal(typeof startup.waitForStartupDrain,'function');
 let elapsed=0;const budgets=[];
 const exited=await startup.waitForStartupDrain(42,{identity,now:()=>elapsed,pollMs:1,
  probe:(_pid,{timeoutMs})=>{budgets.push(timeoutMs);elapsed+=1500;return elapsed>=3000?{state:'absent'}:{state:'present',identity};}});
 assert.equal(exited,true);assert.equal(budgets.length,2);assert(budgets.every(x=>x>0&&x<=2000));
});
test('owned startup drain never accepts late or unverifiable process exit',async()=>{
 assert.equal(typeof startup.waitForStartupDrain,'function');
 let elapsed=0;
 assert.equal(await startup.waitForStartupDrain(42,{identity,timeoutMs:3000,now:()=>elapsed,
  probe:()=>{elapsed=3001;return{state:'absent'};}}),false);
 assert.equal(await startup.waitForStartupDrain(42,{identity,probe:()=>({state:'unverifiable'})}),false);
 const reused={...identity,start_token:'639120000000000001'};
 assert.equal(await startup.waitForStartupDrain(42,{identity,probe:()=>({state:'present',identity:reused})}),true);
 let calls=0;
 for(const timeoutMs of[10001,0,-1,Infinity,'10'])assert.equal(await startup.waitForStartupDrain(42,
  {identity,timeoutMs,probe:()=>{calls++;return{state:'absent'};}}),false);
 assert.equal(calls,0);
});
