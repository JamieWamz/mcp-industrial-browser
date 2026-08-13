import { fetchPage, type FetchPageOptions, type PageSnapshot } from "./browser.js";
import { summarizeSnapshot } from "./extractors.js";

export interface CrawlOptions extends Pick<FetchPageOptions, "timeoutMs" | "waitUntil"> {
  startUrl: string;
  maxPages?: number;
  maxDepth?: number;
  sameOrigin?: boolean;
  linkPattern?: string;
  maxCharactersPerPage?: number;
}

export interface CrawlPageResult {
  url: string;
  depth: number;
  status?: number;
  title?: string;
  summary?: string;
  error?: string;
}

export interface CrawlResult {
  startUrl: string;
  pages: CrawlPageResult[];
  discoveredUrls: number;
}

export async function crawlPages(options: CrawlOptions): Promise<CrawlResult> {
  const maxPages = options.maxPages ?? 5;
  const maxDepth = options.maxDepth ?? 1;
  const sameOrigin = options.sameOrigin ?? true;
  const maxCharactersPerPage = options.maxCharactersPerPage ?? 4000;
  const startUrl = normalizeUrl(options.startUrl);
  let crawlOrigin = new URL(startUrl).origin;
  const linkPattern = compilePattern(options.linkPattern);
  const queue: Array<{ url: string; depth: number }> = [{ url: startUrl, depth: 0 }];
  const queued = new Set([startUrl]);
  const pages: CrawlPageResult[] = [];

  while (queue.length > 0 && pages.length < maxPages) {
    const target = queue.shift();
    if (!target) break;

    try {
      const snapshot = await fetchPage({
        url: target.url,
        timeoutMs: options.timeoutMs,
        waitUntil: options.waitUntil
      });
      const finalUrl = normalizeUrl(snapshot.url);
      queued.add(finalUrl);
      if (target.depth === 0) crawlOrigin = new URL(finalUrl).origin;
      pages.push(toPageResult(snapshot, target.depth, maxCharactersPerPage));

      if (target.depth >= maxDepth) continue;
      for (const link of snapshot.links) {
        const url = normalizeUrl(link.href);
        if (queued.has(url)) continue;
        if (sameOrigin && new URL(url).origin !== crawlOrigin) continue;
        if (linkPattern && !linkPattern.test(url) && !linkPattern.test(link.text)) continue;
        queued.add(url);
        queue.push({ url, depth: target.depth + 1 });
      }
    } catch (error: unknown) {
      pages.push({ url: target.url, depth: target.depth, error: errorMessage(error) });
    }
  }

  return { startUrl, pages, discoveredUrls: queued.size };
}

function toPageResult(snapshot: PageSnapshot, depth: number, maxCharacters: number): CrawlPageResult {
  return {
    url: snapshot.url,
    depth,
    status: snapshot.status,
    title: snapshot.title,
    summary: summarizeSnapshot(snapshot, maxCharacters)
  };
}

function compilePattern(value: string | undefined): RegExp | undefined {
  if (!value) return undefined;
  try {
    return new RegExp(value, "i");
  } catch (error: unknown) {
    throw new Error(`Invalid linkPattern regular expression: ${errorMessage(error)}`);
  }
}

function normalizeUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported URL protocol: ${url.protocol}`);
  }
  url.hash = "";
  return url.href;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
