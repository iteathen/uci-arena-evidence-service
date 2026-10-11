// Synthetic CLI-test platform boundary: never query or mutate actual tasks.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
const original = childProcess.execFile;
childProcess.execFile = (file, args, options, callback) => {
  if (file.toLowerCase() === 'powershell.exe') {
    if (!args.includes('-EncodedCommand')) throw new Error('unexpected fixture platform operation');
    const stdout = Buffer.from(JSON.stringify({schema:'uci_arena_evidence_startup_presence_v1',
      state:process.env.EVIDENCE_FIXTURE_STARTUP_DENIED === '1'?'unverifiable':'absent'}));
    queueMicrotask(() => callback(null,stdout,Buffer.alloc(0)));return {};
  }
  if (file.toLowerCase() === 'schtasks.exe') {
    if (JSON.stringify(args) !== JSON.stringify(['/Query','/TN','UCI Arena Evidence Service','/XML'])) throw new Error('unexpected fixture task mutation');
    const error = Object.assign(new Error('synthetic absent registration'), { code: 1 });
    queueMicrotask(() => callback(error, '', process.env.EVIDENCE_FIXTURE_STARTUP_DENIED === '1' ? 'synthetic access denied' : '')); return {};
  }
  return original(file, args, options, callback);
};
childProcess.execFile[promisify.custom] = (file,args,options) => new Promise((resolve,reject) => {
  childProcess.execFile(file,args,options,(error,stdout,stderr) => error ? reject(error) : resolve({stdout,stderr}));
});
syncBuiltinESMExports();
