#!/usr/bin/env node
import { timingSafeEqual } from "node:crypto";
import {
  createServer as createNodeHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { closeBrowser } from "./browser.js";
import { createServer as createMcpServer } from "./index.js";

export interface HttpServerOptions {
  authToken?: string;
  startedAt?: number;
}

export function createHttpServer(options: HttpServerOptions = {}): Server {
  const startedAt = options.startedAt ?? Date.now();

  return createNodeHttpServer(async (request, response) => {
    try {
      setSecurityHeaders(response);
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;

      if ((request.method === "GET" || request.method === "HEAD") && pathname === "/health") {
        sendJson(
          response,
          200,
          {
            status: "ok",
            service: "mcp-industrial-browser",
            version: "0.2.0",
            uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000)
          },
          request.method === "HEAD"
        );
        return;
      }

      if (pathname !== "/mcp") {
        sendJson(response, 404, { error: "Not found" });
        return;
      }

      if (!isAuthorized(request, options.authToken)) {
        response.setHeader("WWW-Authenticate", "Bearer");
        sendJson(response, 401, { error: "Unauthorized" });
        return;
      }

      if (request.method !== "POST") {
        response.setHeader("Allow", "POST");
        sendJson(response, 405, { error: "Method not allowed" });
        return;
      }

      // Stateless mode is suitable for horizontally scaled and restartable hosts.
      const mcpServer = createMcpServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await mcpServer.connect(transport);
      await transport.handleRequest(request, response);
      response.on("close", () => {
        void transport.close();
        void mcpServer.close();
      });
    } catch (error: unknown) {
      console.error(error);
      if (!response.headersSent) {
        sendJson(response, 500, { error: "Internal server error" });
      } else if (!response.writableEnded) {
        response.end();
      }
    }
  });
}

function isAuthorized(request: IncomingMessage, authToken: string | undefined): boolean {
  if (!authToken) return true;
  const provided = request.headers.authorization;
  if (!provided) return false;
  const expectedBuffer = Buffer.from(`Bearer ${authToken}`);
  const providedBuffer = Buffer.from(provided);
  return providedBuffer.length === expectedBuffer.length && timingSafeEqual(providedBuffer, expectedBuffer);
}

function sendJson(response: ServerResponse, status: number, body: unknown, headOnly = false): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload)
  });
  response.end(headOnly ? undefined : payload);
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Cache-Control", "no-store");
}

function parsePort(value: string | undefined): number {
  if (!value) return 3000;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid PORT: ${value}`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const port = parsePort(process.env.PORT);
  const host = process.env.HOST ?? "0.0.0.0";
  const authToken = process.env.MCP_AUTH_TOKEN;

  if (process.env.NODE_ENV === "production" && !authToken) {
    throw new Error("MCP_AUTH_TOKEN is required when NODE_ENV=production");
  }

  const httpServer = createHttpServer({ authToken });
  httpServer.listen(port, host, () => {
    console.log(`MCP HTTP server listening on http://${host}:${port}/mcp`);
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}; shutting down`);
    await Promise.all([closeServer(httpServer), closeBrowser()]);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
