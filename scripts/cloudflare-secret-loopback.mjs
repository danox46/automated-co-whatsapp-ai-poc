import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const allowedSecrets = new Set([
  "META_APP_SECRET",
  "META_SANDBOX_ACCESS_TOKEN",
  "META_WEBHOOK_VERIFY_TOKEN",
]);

const requestedSecret = process.argv[2];
if (!allowedSecrets.has(requestedSecret)) {
  throw new Error("The requested Cloudflare secret name is not allowlisted.");
}

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const wranglerPath = join(projectRoot, "node_modules", "wrangler", "bin", "wrangler.js");
const configPath = join(projectRoot, "wrangler.mcp.jsonc");
const routeKey = randomBytes(18).toString("base64url");

const page = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Secure Cloudflare secret handoff</title>
<style>body{font:16px system-ui;max-width:36rem;margin:4rem auto;padding:0 1rem}label{display:block;margin:1rem 0}.secret{width:100%;padding:.7rem}button{padding:.7rem 1rem}</style>
<h1>Secure Cloudflare secret handoff</h1>
<p>The value is sent only to this loopback process and then streamed to Cloudflare Wrangler.</p>
<form method="post" action="/${routeKey}">
  <label>${requestedSecret}<input class="secret" name="secret" type="password" autocomplete="off" required minlength="16" maxlength="8192"></label>
  <button type="submit">Store securely</button>
</form>`;

const server = createServer((request, response) => {
  if (request.url !== `/${routeKey}`) {
    response.writeHead(404).end("Not found");
    return;
  }

  if (request.method === "GET") {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    }).end(page);
    return;
  }

  if (request.method !== "POST") {
    response.writeHead(405).end("Method not allowed");
    return;
  }

  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => {
    body += chunk;
    if (body.length > 16384) request.destroy();
  });
  request.on("end", async () => {
    const secretValue = new URLSearchParams(body).get("secret")?.trim();
    body = "";
    if (!secretValue || secretValue.length < 16 || secretValue.length > 8192) {
      response.writeHead(400).end("Secret value rejected");
      return;
    }

    const child = spawn(
      process.execPath,
      [wranglerPath, "secret", "put", requestedSecret, "--config", configPath],
      { cwd: projectRoot, stdio: ["pipe", "ignore", "ignore"], windowsHide: true },
    );
    child.stdin.end(secretValue);
    const exitCode = await new Promise((resolve) => child.once("close", resolve));

    if (exitCode !== 0) {
      response.writeHead(502, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }).end("Cloudflare rejected the secret update");
      return;
    }

    response.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }).end(`${requestedSecret} stored securely`);
    console.log(JSON.stringify({ secret: requestedSecret, stored: true }));
    setTimeout(() => server.close(), 100);
  });
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  console.log(JSON.stringify({ ready: true, url: `http://127.0.0.1:${address.port}/${routeKey}` }));
});
