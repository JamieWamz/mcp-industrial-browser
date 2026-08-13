#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { closeBrowser, fetchPage } from "./browser.js";
import { compareDiagnosticSnapshots } from "./comparison.js";
import { crawlPages } from "./crawler.js";
import { serializeDiagnosticReport, summarizeSnapshot } from "./extractors.js";

const fetchSchema = {
  url: z.string().url().describe("HTTP or HTTPS page to inspect."),
  waitUntil: z.enum(["load", "domcontentloaded", "networkidle"]).default("domcontentloaded"),
  timeoutMs: z.number().int().min(1000).max(120000).default(30000),
  maxCharacters: z.number().int().min(500).max(50000).default(12000),
  waitForSelector: z.string().min(1).max(500).optional().describe("Optional CSS selector to wait for before extracting content.")
};

export function createServer(): McpServer {
  const server = new McpServer({
    name: "mcp-industrial-browser",
    version: "0.2.0"
  });

  server.tool(
    "browse_page",
    "Open a technical web page and return a compact text snapshot with links and tables.",
    fetchSchema,
    async ({ url, waitUntil, timeoutMs, maxCharacters, waitForSelector }) => {
      const snapshot = await fetchPage({ url, waitUntil, timeoutMs, waitForSelector });
      return {
        content: [
          {
            type: "text",
            text: summarizeSnapshot(snapshot, maxCharacters)
          }
        ]
      };
    }
  );

  server.tool(
    "extract_diagnostics",
    "Extract likely industrial maintenance signals from documentation, manuals, or sensor repository pages.",
    fetchSchema,
    async ({ url, waitUntil, timeoutMs, maxCharacters, waitForSelector }) => {
      const snapshot = await fetchPage({ url, waitUntil, timeoutMs, waitForSelector });

      return {
        content: [
          {
            type: "text",
            text: serializeDiagnosticReport(snapshot, maxCharacters)
          }
        ]
      };
    }
  );

  server.tool(
    "compare_diagnostics",
    "Compare baseline and current technical pages to find new or resolved maintenance signals, severity changes, measurement deltas, action changes, and revised headings.",
    {
      baselineUrl: z.string().url().describe("Earlier or known-good technical page."),
      currentUrl: z.string().url().describe("Current technical page to compare against the baseline."),
      waitUntil: z.enum(["load", "domcontentloaded", "networkidle"]).default("domcontentloaded"),
      timeoutMs: z.number().int().min(1000).max(120000).default(30000),
      waitForSelector: z.string().min(1).max(500).optional()
    },
    async ({ baselineUrl, currentUrl, waitUntil, timeoutMs, waitForSelector }) => {
      const [baseline, current] = await Promise.all([
        fetchPage({ url: baselineUrl, waitUntil, timeoutMs, waitForSelector }),
        fetchPage({ url: currentUrl, waitUntil, timeoutMs, waitForSelector })
      ]);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(compareDiagnosticSnapshots(baseline, current), null, 2)
          }
        ]
      };
    }
  );

  server.tool(
    "crawl_pages",
    "Crawl a small, bounded set of linked technical pages and return compact snapshots. Useful for manuals split across multiple pages.",
    {
      startUrl: z.string().url().describe("HTTP or HTTPS page where crawling begins."),
      maxPages: z.number().int().min(1).max(20).default(5),
      maxDepth: z.number().int().min(0).max(3).default(1),
      sameOrigin: z.boolean().default(true),
      linkPattern: z.string().max(500).optional().describe("Optional case-insensitive regular expression applied to link URL and text."),
      timeoutMs: z.number().int().min(1000).max(120000).default(30000),
      maxCharactersPerPage: z.number().int().min(500).max(10000).default(4000)
    },
    async ({ startUrl, maxPages, maxDepth, sameOrigin, linkPattern, timeoutMs, maxCharactersPerPage }) => {
      const result = await crawlPages({
        startUrl,
        maxPages,
        maxDepth,
        sameOrigin,
        linkPattern,
        timeoutMs,
        maxCharactersPerPage
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "list_page_links",
    "Open a page and return discovered links for crawling manuals, datasheets, and repositories.",
    {
      url: z.string().url(),
      timeoutMs: z.number().int().min(1000).max(120000).default(30000)
    },
    async ({ url, timeoutMs }) => {
      const snapshot = await fetchPage({ url, timeoutMs });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ source: snapshot.url, links: snapshot.links }, null, 2)
          }
        ]
      };
    }
  );

  return server;
}

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  process.on("SIGINT", () => {
    void closeBrowser().finally(() => process.exit(0));
  });

  process.on("SIGTERM", () => {
    void closeBrowser().finally(() => process.exit(0));
  });

  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
