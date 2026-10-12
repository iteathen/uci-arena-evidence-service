import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { NativeResourceHelper } from '../src/native-resource-helper.mjs';

const nativeHelper = process.env.UCI_ARENA_NATIVE_HELPER;
const skip = process.platform !== 'win32' || !nativeHelper ? 'requires explicitly selected Windows native helper' : false;
test('native owned child rejects birth/executable mismatches then positively stops', { skip }, async (t) => {
  const helper = new NativeResourceHelper({ nativeHelperAvailable: true, nativeHelper });
  assert.ok((await helper.probe()).capabilities.includes('process_instance_stop_v1'));
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  const exited = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null) child.kill(); await exited; });
  const observation = helper.queryProcessInstanceSync(child.pid);
  assert.equal(observation.state, 'present');
  const identity = observation.identity;
  for (const changed of [{ ...identity, start_token: String(BigInt(identity.start_token) + 1n) },
    { ...identity, executable_path: `${identity.executable_path}.wrong` }]) {
    assert.deepEqual(helper.stopProcessInstanceSync(changed), { schema: 'uci_arena_process_instance_stop_v1', state: 'reused' });
    assert.equal(helper.queryProcessInstanceSync(child.pid).state, 'present');
  }
  assert.deepEqual(helper.stopProcessInstanceSync(identity), { schema: 'uci_arena_process_instance_stop_v1', state: 'stopped' });
  await exited;
  assert.equal(helper.queryProcessInstanceSync(child.pid).state, 'absent');
  assert.deepEqual(helper.stopProcessInstanceSync(identity), { schema: 'uci_arena_process_instance_stop_v1', state: 'absent' });
});

test('native stop rejects incomplete invalid bounded transport without process effects', { skip }, () => {
  for (const input of ['', '0\n639111234567890123\n2000\nC:\\child.exe\n',
    '1\n639111234567890123\n0\nC:\\child.exe\n', '1\n639111234567890123\n2001\nC:\\child.exe\n',
    '1\n639111234567890123\n2000\nrelative.exe\n',
    '1\n639111234567890123\n2000\nC:\\child.exe\nextra\n',
    '1\n1\n2000\nC:\\child.exe\n', Buffer.from([255])]) {
    assert.throws(() => execFileSync(nativeHelper, ['--stop-process-instance'], {
      input, windowsHide: true, timeout: 2000, stdio: ['pipe', 'pipe', 'ignore'],
    }), (error) => error.status === 2 && error.stdout.length === 0);
  }
});
