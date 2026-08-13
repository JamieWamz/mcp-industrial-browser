import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { createHttpServer } from "../src/http.js";

describe("HTTP server boundary", () => {
  it("serves health checks and protects the MCP endpoint", async () => {
    const server = createHttpServer({ authToken: "test-secret" });
    const baseUrl = await listen(server);

    try {
      const discovery = await fetch(baseUrl);
      assert.equal(discovery.status, 200);
      assert.deepEqual(await discovery.json(), {
        service: "mcp-industrial-browser",
        version: "0.3.0",
        status: "ready",
        transport: { type: "Streamable HTTP", endpoint: "/mcp", method: "POST" },
        health: "/health",
        authentication: "Bearer token required",
        tools: [
          "browse_page",
          "extract_diagnostics",
          "compare_diagnostics",
          "crawl_pages",
          "inspect_fleet",
          "list_page_links"
        ]
      });

      const health = await fetch(`${baseUrl}/health`);
      assert.equal(health.status, 200);
      assert.equal(health.headers.get("cache-control"), "no-store");
      const healthPayload = (await health.json()) as Record<string, unknown>;
      const { uptimeSeconds, ...healthMetadata } = healthPayload;
      assert.deepEqual(healthMetadata, {
        status: "ok",
        service: "mcp-industrial-browser",
        version: "0.3.0"
      });
      assert.ok(Number.isInteger(uptimeSeconds) && Number(uptimeSeconds) >= 0);

      const head = await fetch(`${baseUrl}/health`, { method: "HEAD" });
      assert.equal(head.status, 200);
      assert.equal(await head.text(), "");
      assert.ok(Number(head.headers.get("content-length")) > 0);

      const unauthorized = await fetch(`${baseUrl}/mcp`);
      assert.equal(unauthorized.status, 401);
      assert.equal(unauthorized.headers.get("www-authenticate"), "Bearer");

      const wrongMethod = await fetch(`${baseUrl}/mcp`, {
        headers: { Authorization: "Bearer test-secret" }
      });
      assert.equal(wrongMethod.status, 405);
      assert.equal(wrongMethod.headers.get("allow"), "POST");

      const missing = await fetch(`${baseUrl}/missing`);
      assert.equal(missing.status, 404);
    } finally {
      await close(server);
    }
  });
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
