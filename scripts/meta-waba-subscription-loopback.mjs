import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const wabaId = process.argv[2];
const appId = process.argv[3];
const graphVersion = process.argv[4] ?? "v25.0";

if (!/^\d{8,32}$/.test(wabaId ?? "") || !/^\d{8,32}$/.test(appId ?? "") || !/^v\d+\.\d+$/.test(graphVersion)) {
  throw new Error("Expected numeric WABA/app IDs and a Graph API version.");
}

const routeKey = randomBytes(18).toString("base64url");
const page = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Secure Meta WABA subscription</title>
<style>body{font:16px system-ui;max-width:36rem;margin:4rem auto;padding:0 1rem}label{display:block;margin:1rem 0}.secret{width:100%;padding:.7rem}button{padding:.7rem 1rem}</style>
<h1>Secure Meta WABA subscription</h1>
<p>The access token remains inside this loopback process and is used only for the fixed WABA subscription and readback.</p>
<form method="post" action="/${routeKey}">
  <label>Meta access token<input class="secret" name="token" type="password" autocomplete="off" required minlength="16" maxlength="8192"></label>
  <button type="submit">Subscribe and verify</button>
</form>`;

const send = (response, status, body) => {
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  }).end(body);
};

const server = createServer((request, response) => {
  if (request.url !== `/${routeKey}`) {
    send(response, 404, "Not found");
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
    send(response, 405, "Method not allowed");
    return;
  }

  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => {
    body += chunk;
    if (body.length > 16384) request.destroy();
  });
  request.on("end", async () => {
    const token = new URLSearchParams(body).get("token")?.trim();
    body = "";
    if (!token || token.length < 16 || token.length > 8192) {
      send(response, 400, "Access token rejected");
      return;
    }

    try {
      const endpoint = `https://graph.facebook.com/${graphVersion}/${wabaId}/subscribed_apps`;
      const headers = { authorization: `Bearer ${token}` };
      const subscriptionResponse = await fetch(endpoint, { method: "POST", headers });
      if (!subscriptionResponse.ok) {
        console.log(JSON.stringify({ subscribed: false, step: "subscribe", status: subscriptionResponse.status }));
        send(response, 502, "Meta rejected the WABA subscription");
        return;
      }

      const readbackResponse = await fetch(`${endpoint}?fields=id,name`, { headers });
      const readback = readbackResponse.ok ? await readbackResponse.json() : null;
      const appFound = Array.isArray(readback?.data) && readback.data.some((item) => String(item?.id) === appId);
      console.log(JSON.stringify({ subscribed: true, readbackStatus: readbackResponse.status, appFound }));
      send(response, appFound ? 200 : 502, appFound ? "WABA subscription verified" : "Subscription succeeded but readback did not include the app");
      setTimeout(() => server.close(), 100);
    } catch {
      console.log(JSON.stringify({ subscribed: false, step: "network" }));
      send(response, 502, "Meta subscription request failed");
    }
  });
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  console.log(JSON.stringify({ ready: true, url: `http://127.0.0.1:${address.port}/${routeKey}` }));
});
