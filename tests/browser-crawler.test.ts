import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { closeBrowser, fetchPage } from "../src/browser.js";
import { crawlPages } from "../src/crawler.js";

let fixtureServer: Server;
let baseUrl: string;

before(async () => {
  fixtureServer = createServer((request, response) => {
    if (request.url === "/redirect") {
      response.writeHead(302, { Location: "/manual/index.html" });
      response.end();
      return;
    }

    if (request.url === "/manual/index.html") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(`<!doctype html>
        <html>
          <head><title>Pump manual</title><meta name="description" content="Pump service data"></head>
          <body>
            <h1>Maintenance</h1>
            <a href="/manual/index.html#top">Current page</a>
            <a href="/manual/next.html#bearing">Bearing procedure</a>
            <a href="/manual/next.html">Duplicate procedure</a>
            <a href="https://example.com/external">External reference</a>
            <table>
              <caption>Bearing readings</caption>
              <thead><tr><th>Sensor</th><th>Reading</th></tr></thead>
              <tbody><tr><td>Bearing A</td><td>12.5 mm/s</td></tr></tbody>
            </table>
          </body>
        </html>`);
      return;
    }

    if (request.url === "/manual/next.html") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>Bearing procedure</title><h1>Inspect bearing</h1><p>Temperature limit: 80 °C.</p>");
      return;
    }

    response.writeHead(404);
    response.end("Not found");
  });

  await new Promise<void>((resolve, reject) => {
    fixtureServer.once("error", reject);
    fixtureServer.listen(0, "127.0.0.1", resolve);
  });
  const address = fixtureServer.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await closeBrowser();
  await new Promise<void>((resolve, reject) => {
    fixtureServer.close((error) => (error ? reject(error) : resolve()));
  });
});

describe("browser snapshots", () => {
  it("captures redirects, headings, deduplicated links, and tables", async () => {
    const snapshot = await fetchPage({
      url: `${baseUrl}/redirect`,
      waitForSelector: "table"
    });

    assert.equal(snapshot.url, `${baseUrl}/manual/index.html`);
    assert.equal(snapshot.status, 200);
    assert.equal(snapshot.title, "Pump manual");
    assert.equal(snapshot.description, "Pump service data");
    assert.deepEqual(snapshot.headings, [{ level: 1, text: "Maintenance" }]);
    assert.equal(snapshot.links.filter(({ href }) => href.endsWith("/manual/next.html")).length, 1);
    assert.deepEqual(snapshot.tables, [
      {
        caption: "Bearing readings",
        headers: ["Sensor", "Reading"],
        rows: [["Bearing A", "12.5 mm/s"]]
      }
    ]);
  });
});

describe("bounded crawling", () => {
  it("does not revisit the redirect target and stays on the final origin", async () => {
    const result = await crawlPages({
      startUrl: `${baseUrl}/redirect`,
      maxPages: 5,
      maxDepth: 1,
      sameOrigin: true
    });

    assert.deepEqual(
      result.pages.map(({ url, depth, status }) => ({ url, depth, status })),
      [
        { url: `${baseUrl}/manual/index.html`, depth: 0, status: 200 },
        { url: `${baseUrl}/manual/next.html`, depth: 1, status: 200 }
      ]
    );
    assert.equal(result.discoveredUrls, 3);
  });
});
