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
      const health = await fetch(`${baseUrl}/health`);
      assert.equal(health.status, 200);
      assert.equal(health.headers.get("cache-control"), "no-store");
      assert.deepEqual(await health.json(), {
        status: "ok",
        service: "mcp-industrial-browser",
        version: "0.2.0",
        uptimeSeconds: 0
      });

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
