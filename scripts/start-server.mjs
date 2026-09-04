import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

// Include the OS certificate store on runtimes that support it (including Node 24
// on this PC). TLS verification stays enabled for Twilio and media downloads.
const flags = process.allowedNodeEnvironmentFlags.has("--use-system-ca")
  ? ["--use-system-ca"]
  : [];
const children = [];
let stopping = false;
function stop(signal = 'SIGTERM') {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill(signal);
}
function launch(script) {
  const child = spawn(process.execPath, [...flags, script], { stdio: 'inherit', env: process.env });
  children.push(child);
  child.on('error', error => { console.error('Unable to start inbox component:', error.message); process.exitCode = 1; stop(); });
  child.on('exit', code => { if (!stopping) { process.exitCode = code ?? 1; stop(); } });
}
launch('dist/server.js');
if (existsSync('.runtime/phone-auth.json') && existsSync('.runtime/phone-tunnel-token')) {
  launch('scripts/phone-gateway.mjs');
  launch('scripts/start-phone-tunnel.mjs');
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => stop(signal));
}
