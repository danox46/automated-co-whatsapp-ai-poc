import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const token = readFileSync('.runtime/phone-tunnel-token', 'utf8').trim();
if (!token) throw new Error('Phone tunnel token missing');
const child = spawn(process.execPath, ['node_modules/cloudflared/lib/cloudflared.js', 'tunnel', '--no-autoupdate', 'run'], {
  env: { ...process.env, TUNNEL_TOKEN: token }, stdio: 'inherit',
});
child.on('error', () => { console.error('Unable to start phone tunnel'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
