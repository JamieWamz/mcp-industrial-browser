import { chromium, type Browser, type Page } from "playwright";

export interface FetchPageOptions {
  url: string;
  waitUntil?: "load" | "domcontentloaded" | "networkidle";
  timeoutMs?: number;
  userAgent?: string;
  waitForSelector?: string;
  blockHeavyResources?: boolean;
}

export interface PageSnapshot {
  url: string;
  title: string;
  description: string;
  status: number;
  contentType: string;
  text: string;
  headings: Array<{ level: number; text: string }>;
  links: Array<{ text: string; href: string }>;
  tables: Array<{ caption?: string; headers: string[]; rows: string[][] }>;
}

let browserPromise: Promise<Browser> | undefined;

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    const launchPromise = chromium.launch({
      headless: true,
      chromiumSandbox: process.env.PLAYWRIGHT_CHROMIUM_SANDBOX === "true"
    });
    browserPromise = launchPromise;

    void launchPromise.then(
      (browser) => {
        browser.once("disconnected", () => {
          if (browserPromise === launchPromise) browserPromise = undefined;
        });
      },
      () => {
        if (browserPromise === launchPromise) browserPromise = undefined;
      }
    );
  }

  return browserPromise;
}

export async function fetchPage(options: FetchPageOptions): Promise<PageSnapshot> {
  assertSupportedUrl(options.url);
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent:
      options.userAgent ??
      "mcp-industrial-browser/0.2 (+https://github.com/JamieWamz/mcp-industrial-browser)"
  });

  try {
    if (options.blockHeavyResources ?? true) {
      await context.route("**/*", async (route) => {
        const type = route.request().resourceType();
        if (type === "image" || type === "media" || type === "font") {
          await route.abort();
        } else {
          await route.continue();
        }
      });
    }

    const page = await context.newPage();
    page.setDefaultTimeout(options.timeoutMs ?? 30000);
    const response = await page.goto(options.url, {
      waitUntil: options.waitUntil ?? "domcontentloaded",
      timeout: options.timeoutMs ?? 30000
    });
    if (options.waitForSelector) {
      await page.locator(options.waitForSelector).first().waitFor({ state: "attached" });
    }
    return await snapshotPage(
      page,
      response?.status() ?? 0,
      response?.headers()["content-type"] ?? ""
    );
  } finally {
    await context.close();
  }
}

export async function closeBrowser(): Promise<void> {
  if (!browserPromise) {
    return;
  }

  const pendingBrowser = browserPromise;
  browserPromise = undefined;
  const browser = await pendingBrowser.catch(() => undefined);
  await browser?.close();
}

async function snapshotPage(page: Page, status: number, contentType: string): Promise<PageSnapshot> {
  const extracted = await page.evaluate(() => {
    const headings = Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6"))
      .map((heading) => ({
        level: Number(heading.tagName.slice(1)),
        text: (heading.textContent ?? "").replace(/\s+/g, " ").trim()
      }))
      .filter((heading) => heading.text.length > 0)
      .slice(0, 100);
    const links = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]")).map(
      (anchor) => ({
        text: (anchor.textContent || anchor.getAttribute("aria-label") || "")
          .replace(/\s+/g, " ")
          .trim(),
        href: anchor.href
      })
    );
    const tables = Array.from(document.querySelectorAll("table"))
      .slice(0, 20)
      .map((table) => {
        const headerCells = Array.from(table.querySelectorAll("thead th"));
        const firstRowHeaderCells = Array.from(table.querySelectorAll("tr:first-child th"));
        const headers = (headerCells.length > 0 ? headerCells : firstRowHeaderCells).map((cell) =>
          (cell.textContent ?? "").replace(/\s+/g, " ").trim()
        );
        const rows = Array.from(table.querySelectorAll("tbody tr, tr"))
          .slice(headers.length > 0 ? 1 : 0, 51)
          .map((row) =>
            Array.from(row.querySelectorAll("th, td")).map((cell) =>
              (cell.textContent ?? "").replace(/\s+/g, " ").trim()
            )
          )
          .filter((row) => row.some(Boolean));

        return {
          caption:
            (table.querySelector("caption")?.textContent ?? "").replace(/\s+/g, " ").trim() ||
            undefined,
          headers,
          rows
        };
      });

    return {
      title: document.title,
      description: document.querySelector<HTMLMetaElement>('meta[name="description"]')?.content ?? "",
      text: document.body?.innerText ?? "",
      headings,
      links,
      tables
    };
  });

  return {
    url: page.url(),
    title: normalizeWhitespace(extracted.title),
    description: normalizeWhitespace(extracted.description),
    status,
    contentType,
    text: normalizeWhitespace(extracted.text),
    headings: extracted.headings,
    links: normalizeLinks(extracted.links),
    tables: extracted.tables
  };
}

function normalizeLinks(links: Array<{ text: string; href: string }>): PageSnapshot["links"] {
  const uniqueLinks = new Map<string, { text: string; href: string }>();
  for (const link of links) {
    try {
      const parsed = new URL(link.href);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
      parsed.hash = "";
      const href = parsed.href;
      const current = uniqueLinks.get(href);
      if (!current || (!current.text && link.text)) {
        uniqueLinks.set(href, { text: link.text, href });
      }
    } catch {
      // Browsers can expose malformed href values from unusual documents.
    }
  }

  return Array.from(uniqueLinks.values()).slice(0, 200);
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function assertSupportedUrl(value: string): void {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported URL protocol: ${url.protocol}`);
  }
}
