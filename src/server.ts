import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createApp } from "./app.js";
import { loadConfig } from "./config/env.js";
import { logger } from "./logging/logger.js";
import { createInternalMcpLocalRuntime } from "./mcp/localRuntime.js";

const MAX_LOCAL_MCP_REQUEST_BYTES = 1_048_576;
const config = loadConfig();

if (config.whatsappProvider === "legacy_twilio") {
  const app = createApp(config);
  app.listen(config.port, () => {
    logger.warn("Legacy Twilio server started", {
      port: config.port,
      activeProvider: "legacy_twilio",
      defaultProvider: "internal_mcp"
    });
  });
} else {
  const runtime = createInternalMcpLocalRuntime(config);
  const server = createServer(async (request, response) => {
    try {
      const fetchRequest = await toFetchRequest(request, config.port);
      const fetchResponse = await runtime.fetch(fetchRequest);
      await writeFetchResponse(response, fetchResponse);
    } catch (error) {
      logger.error("Internal MCP request failed", {
        error: error instanceof Error ? error.message : "unknown error"
      });
      if (!response.headersSent) {
        response.statusCode = 500;
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        response.setHeader("Cache-Control", "no-store");
      }
      response.end(JSON.stringify({ ok: false, error: "internal_mcp_request_failed" }));
    }
  });

  server.listen(config.port, () => {
    logger.info("Internal WhatsApp MCP server started", {
      port: config.port,
      activeProvider: "internal_mcp",
      legacyTwilioEnabled: false,
      oauthVerifierConfigured: false,
      outboundMessagingConfigured: false
    });
  });
}

async function toFetchRequest(request: IncomingMessage, port: number): Promise<Request> {
  const forwardedProtocol = firstHeaderValue(request.headers["x-forwarded-proto"]);
  const protocol = forwardedProtocol === "https" ? "https" : "http";
  const host = request.headers.host ?? `localhost:${port}`;
  const url = new URL(request.url ?? "/", `${protocol}://${host}`);
  const headers = new Headers();

  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }

  const method = request.method ?? "GET";
  const body = method === "GET" || method === "HEAD" ? undefined : await readRequestBody(request);
  return new Request(url, { method, headers, body });
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value?.split(",", 1)[0]?.trim();
}

async function readRequestBody(request: IncomingMessage): Promise<ArrayBuffer | undefined> {
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_LOCAL_MCP_REQUEST_BYTES) {
      throw new Error("MCP request body exceeds the 1 MiB local limit");
    }
    chunks.push(bytes);
  }
  if (chunks.length === 0) return undefined;
  const combined = Buffer.concat(chunks);
  const body = new Uint8Array(combined.length);
  body.set(combined);
  return body.buffer;
}

async function writeFetchResponse(response: ServerResponse, fetchResponse: Response): Promise<void> {
  response.statusCode = fetchResponse.status;
  fetchResponse.headers.forEach((value, name) => response.setHeader(name, value));

  if (!fetchResponse.body) {
    response.end();
    return;
  }

  const reader = fetchResponse.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    response.write(Buffer.from(value));
  }
  response.end();
}
