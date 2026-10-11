import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { offlineStartupPresence } from '../src/platform_startup.mjs';
const execute = promisify(execFile);
const schema = 'uci_arena_evidence_startup_presence_v1';
test('offline Windows observation admits only bounded closed typed presence',async()=>{
  const valid = Buffer.from(JSON.stringify({schema,state:'absent'}));
  assert.equal((await offlineStartupPresence(null,{platform:'win32',execute:async()=>({stdout:valid})})).state,'absent');
  for (const stdout of [Buffer.from('{"schema":"unknown","state":"absent"}'),Buffer.from(JSON.stringify({schema,state:'absent',extra:true})),
    Buffer.from(JSON.stringify({schema,state:'unverifiable'})),Buffer.from(JSON.stringify({schema,state:'present'})),
    Buffer.alloc(4097),Buffer.from([0xff]),Buffer.from('PRIVATE_INVALID_JSON')]) {
    const result=await offlineStartupPresence(null,{platform:'win32',execute:async()=>({stdout})});assert.notEqual(result.state,'absent');
  }
  assert.equal((await offlineStartupPresence(null,{platform:'win32',execute:async()=>{throw Object.assign(new Error('PRIVATE_ACCESS_DENIED'),{code:1});}})).state,'unverifiable');
});
test('Linux unit absence distinguishes exact ENOENT from permission and other failures',async()=>{
  for (const [code,want] of [['ENOENT','absent'],['EACCES','unverifiable'],['EPERM','unverifiable'],['ENOTDIR','unverifiable']]) {
    const result=await offlineStartupPresence(null,{platform:'linux',stat:()=>{throw Object.assign(new Error('PRIVATE'),{code});}});
    assert.equal(result.state,want);
  }
  assert.equal((await offlineStartupPresence(null,{platform:'linux',stat:()=>({})})).state,'present');
});
test('invalid observation bounds and unsupported hosts never invoke a query',async()=>{
  const query=()=>{throw new Error('must not invoke');};
  for(const timeoutMs of [0,-1,10001,1.5,NaN])assert.equal((await offlineStartupPresence(null,{platform:'win32',execute:query,timeoutMs})).state,'unverifiable');
  assert.equal((await offlineStartupPresence(null,{platform:'unsupported',execute:query})).state,'unverifiable');
});
const nativeTest=process.platform==='win32'?test:test.skip;
nativeTest('real PowerShell COM exception classification proves only exact GetTask file absence',async()=>{
  const cases=[
    {stage:'task',kind:'com',code:-2147024894,want:'absent'},
    {stage:'task',kind:'com',code:-2147024891,want:'unverifiable'},
    {stage:'task',kind:'com',code:-2147024893,want:'unverifiable'},
    {stage:'folder',kind:'com',code:-2147024894,want:'unverifiable'},
    {stage:'connect',kind:'com',code:-2147024894,want:'unverifiable'},
    {stage:'task',kind:'io',code:-2147024894,want:'unverifiable'},
    {stage:'task',kind:'mapped-file',code:-2147024894,want:'absent'},
    {stage:'task',kind:'mapped-file',code:-2147024891,want:'unverifiable'},
    {stage:'task',kind:'mapped-file',code:-2147024893,want:'unverifiable'},
    {stage:'folder',kind:'mapped-file',code:-2147024894,want:'unverifiable'},
    {stage:'connect',kind:'mapped-file',code:-2147024894,want:'unverifiable'},
    {stage:'task',kind:'null',code:0,want:'unverifiable'},
    {stage:'task',kind:'found',code:0,want:'present'},
  ];
  for(const host of ['powershell.exe','pwsh.exe']) for(const sample of cases) {
    const simulated = async(file,args,options)=>{
      assert.equal(file,'powershell.exe');assert.equal(options.windowsHide,true);assert.ok(options.timeout>=1&&options.timeout<=10000);
      const index=args.indexOf('-EncodedCommand'),body=Buffer.from(args[index+1],'base64').toString('utf16le');
      // New-Object is shadowed before the unmodified owned script executes.
      // Script methods throw actual typed .NET exceptions; no Task Scheduler is opened.
      const prefix=`
        $script:fixtureStage='${sample.stage}'
        $script:fixtureKind='${sample.kind}'
        $script:fixtureCode=${sample.code}
        function ThrowFixture {
          if ($script:fixtureKind -eq 'io') { throw [System.IO.IOException]::new('PRIVATE_FIXTURE',[int]$script:fixtureCode) }
          if ($script:fixtureKind -eq 'mapped-file') {
            $mapped=[System.IO.FileNotFoundException]::new('PRIVATE_FIXTURE')
            [System.Exception].GetProperty('HResult').SetValue($mapped,[int]$script:fixtureCode)
            throw $mapped
          }
          throw [System.Runtime.InteropServices.COMException]::new('PRIVATE_FIXTURE',[int]$script:fixtureCode)
        }
        function New-Object {
          param([string]$ComObject)
          if($ComObject -ne 'Schedule.Service') { throw 'unexpected activation' }
          $folder=[pscustomobject]@{}
          $folder | Add-Member -MemberType ScriptMethod -Name GetTask -Value {
            param($name)
            if($name -ne 'UCI Arena Evidence Service') {throw 'unexpected task'}
            if($script:fixtureKind -eq 'found') {return [pscustomobject]@{fixture='present'}}
            if($script:fixtureKind -eq 'null') {return $null}
            ThrowFixture
          }
          $service=[pscustomobject]@{Folder=$folder}
          $service | Add-Member -MemberType ScriptMethod -Name Connect -Value {if($script:fixtureStage -eq 'connect'){ThrowFixture}}
          $service | Add-Member -MemberType ScriptMethod -Name GetFolder -Value {param($root) if($script:fixtureStage -eq 'folder'){ThrowFixture};return $this.Folder}
          return $service
        }
      `;
      const modified=[...args];modified[index+1]=Buffer.from(prefix+'\n'+body,'utf16le').toString('base64');
      return execute(host,modified,options);
    };
    const result=await offlineStartupPresence(null,{platform:'win32',execute:simulated});
    assert.equal(result.state,sample.want,JSON.stringify({host,...sample}));
  }
});
nativeTest('real missing Task Scheduler lookup is absent through both PowerShell hosts without mutation',async()=>{
  const name='Evidence-readonly-missing-fixture-'+randomUUID();
  for(const host of ['powershell.exe','pwsh.exe']) {
    const result=await offlineStartupPresence(null,{platform:'win32',execute:async(file,args,options)=>{
      assert.equal(file,'powershell.exe');
      const index=args.indexOf('-EncodedCommand'),body=Buffer.from(args[index+1],'base64').toString('utf16le');
      assert.ok(body.includes("-TaskName 'UCI Arena Evidence Service'"));
      const modified=[...args];modified[index+1]=Buffer.from(body.replace("-TaskName 'UCI Arena Evidence Service'",`-TaskName '${name}'`),'utf16le').toString('base64');
      return execute(host,modified,options);
    }});
    assert.equal(result.state,'absent',host);
  }
});
