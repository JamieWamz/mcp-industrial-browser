# mcp-industrial-browser

An MCP (Model Context Protocol) server for industrial web intelligence. It uses TypeScript and Playwright to help AI agents browse, scrape, and extract structured diagnostic data from technical documentation and sensor repositories for predictive maintenance workflows.

## Features

- `browse_page`: opens a technical page and returns a compact text snapshot with links and tables.
- `extract_diagnostics`: returns maintenance signals, severity totals, numeric sensor readings, recommended actions, and evidence from prose and tables.
- `compare_diagnostics`: compares baseline and current pages for new/resolved signals, severity changes, measurement deltas, revised actions, and heading changes.
- `list_page_links`: extracts and deduplicates HTTP(S) crawl targets from manuals, datasheets, repositories, and vendor documentation.
- `crawl_pages`: follows a bounded number of links across multi-page manuals, with depth, same-origin, and regular-expression filters.
- `inspect_fleet`: inspects up to 20 named assets concurrently, ranks maintenance risk, tolerates individual failures, and aggregates fleet-wide signals, actions, and measurement ranges.

Browser snapshots include the final URL after redirects, HTTP status, page description, heading structure, visible text, links, and tables. Heavy image, media, and font requests are skipped by default to keep text extraction fast.

## Install

```bash
npm install
npx playwright install chromium
npm run build
```

## Run locally with stdio

```bash
npm start
```

For development:

```bash
npm run dev
```

This mode is intended for an MCP client running on the same machine.

## Run as a remote MCP server

The hosted server uses stateless Streamable HTTP at `/mcp`, exposes a health check at `/health`, and publishes service/tool discovery metadata at `/`.

```bash
npm run build
MCP_AUTH_TOKEN="replace-with-a-long-random-secret" npm run start:http
```

The server listens on `0.0.0.0` and uses the hosting provider's `PORT` environment variable (default: `3000`). Test it locally with:

```bash
curl http://localhost:3000/health
```

Open `http://localhost:3000/` in a browser to confirm the running version, authentication mode, endpoint, and available tools.

Do not expose the service without authentication. `MCP_AUTH_TOKEN` is mandatory when `NODE_ENV=production`.

The server can fetch arbitrary HTTP(S) URLs. Give bearer tokens only to trusted clients and, for an internet-facing deployment, use your host's network-egress controls to block private services and cloud metadata endpoints.

## Deploy with Docker

The included `Dockerfile` contains Chromium and all of its system dependencies. This is the recommended way to deploy the project to any container host, such as Render, Railway, Fly.io, Google Cloud Run, or an ordinary VPS.

1. Push this repository to GitHub.
2. Create a new web service from the repository and select Docker as its runtime.
3. Set `MCP_AUTH_TOKEN` to a long random secret in the provider's environment settings.
4. Configure the health-check path as `/health`.
5. Deploy. The public MCP endpoint will be `https://your-domain.example/mcp`.

To validate the image locally:

```bash
docker build -t mcp-industrial-browser .
docker run --rm -p 3000:3000 \
  -e MCP_AUTH_TOKEN="replace-with-a-long-random-secret" \
  mcp-industrial-browser
```

Send the bearer token in the `Authorization` header when connecting a remote MCP client:

```text
Authorization: Bearer replace-with-a-long-random-secret
```

Exact remote-server configuration differs by MCP client. Use the deployed `/mcp` URL as a Streamable HTTP server URL and add the header above. Keep using the stdio configuration below for local clients.

## MCP Client Configuration

After building, register the server with an MCP client using stdio:

```json
{
  "mcpServers": {
    "industrial-browser": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-industrial-browser/dist/index.js"]
    }
  }
}
```

## Example Tool Inputs

```json
{
  "url": "https://example.com/industrial-manual",
  "waitUntil": "domcontentloaded",
  "timeoutMs": 30000,
  "maxCharacters": 12000,
  "waitForSelector": "main"
}
```

To crawl a manual section:

```json
{
  "startUrl": "https://example.com/manual/",
  "maxPages": 8,
  "maxDepth": 2,
  "sameOrigin": true,
  "linkPattern": "maintenance|troubleshooting|alarm"
}
```

To compare a current diagnostic page with a known baseline:

```json
{
  "baselineUrl": "https://example.com/pump-7/baseline",
  "currentUrl": "https://example.com/pump-7/current",
  "timeoutMs": 30000
}
```

To inspect and rank a fleet:

```json
{
  "assets": [
    { "name": "Pump A", "url": "https://example.com/assets/pump-a" },
    { "name": "Pump B", "url": "https://example.com/assets/pump-b" },
    { "name": "Compressor 3", "url": "https://example.com/assets/compressor-3" }
  ],
  "concurrency": 3,
  "maxCharacters": 30000
}
```

Fleet risk scores are explainable heuristics, not safety certifications. Each unique informational, warning, and critical signal contributes 2, 12, and 30 points respectively, capped at 100. Health score is `100 - risk score`; any critical signal produces a critical risk level. Validate maintenance decisions against manufacturer guidance and qualified personnel.

## Development

```bash
npm run check
npm test
npm run build
```

Or run all verification steps together with `npm run verify`.

The test suite covers diagnostic extraction, browser snapshots, bounded crawling, redirects, and the HTTP health/authentication boundary. Install Chromium before running it locally:

```bash
npx playwright install chromium
```

To develop the HTTP transport:

```bash
MCP_AUTH_TOKEN=dev-secret npm run dev:http
```

The server launches Chromium in headless mode, opens a fresh browser context per request, normalizes page text, extracts links and tables, and returns MCP text content that downstream agents can summarize or transform into maintenance workflows.

## License

MIT
