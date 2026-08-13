import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FetchPageOptions, PageSnapshot } from "../src/browser.js";
import { inspectFleet, serializeFleetInspection, type FleetAsset } from "../src/fleet.js";

function snapshot(url: string, text: string): PageSnapshot {
  return {
    url,
    title: new URL(url).pathname.slice(1),
    description: "",
    status: 200,
    contentType: "text/html",
    text,
    headings: [],
    links: [],
    tables: []
  };
}

describe("fleet inspection", () => {
  it("bounds concurrency, tolerates failures, ranks assets, and aggregates readings", async () => {
    const assets: FleetAsset[] = [
      { name: "Pump A", url: "https://example.com/pump-a" },
      { name: "Pump B", url: "https://example.com/pump-b" },
      { name: "Pump C", url: "https://example.com/pump-c" },
      { name: "Offline pump", url: "https://example.com/offline" }
    ];
    let active = 0;
    let maximumActive = 0;
    const pageFetcher = async ({ url }: FetchPageOptions): Promise<PageSnapshot> => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      if (url.endsWith("offline")) throw new Error("Connection refused");
      if (url.endsWith("pump-a")) {
        return snapshot(url, "Critical vibration failure at 14 mm/s. Replace the bearing immediately.");
      }
      if (url.endsWith("pump-b")) {
        return snapshot(url, "Vibration is 6 mm/s. Inspect the bearing weekly.");
      }
      return snapshot(url, "Normal production output is 2,000 rpm.");
    };

    const inspection = await inspectFleet({ assets, concurrency: 2 }, pageFetcher);

    assert.equal(maximumActive, 2);
    assert.deepEqual(inspection.summary, {
      requested: 4,
      succeeded: 3,
      failed: 1,
      averageHealthScore: 84.67,
      riskCounts: { low: 1, medium: 1, high: 0, critical: 1 },
      severityCounts: { info: 2, warning: 1, critical: 1 }
    });
    assert.deepEqual(
      inspection.assets.map(({ asset, riskScore, healthScore, riskLevel }) => ({
        name: asset.name,
        riskScore,
        healthScore,
        riskLevel
      })),
      [
        { name: "Pump A", riskScore: 32, healthScore: 68, riskLevel: "critical" },
        { name: "Pump B", riskScore: 14, healthScore: 86, riskLevel: "medium" },
        { name: "Pump C", riskScore: 0, healthScore: 100, riskLevel: "low" }
      ]
    );
    assert.deepEqual(inspection.failures, [
      { asset: assets[3], error: "Connection refused" }
    ]);
    assert.deepEqual(inspection.signalFrequency, [
      { signal: "maintenance action", assetCount: 2 },
      { signal: "vibration anomaly", assetCount: 2 }
    ]);
    assert.deepEqual(inspection.measurementRanges, [
      { unit: "MM/S", readings: 2, assetCount: 2, minimum: 6, maximum: 14, average: 10 },
      { unit: "RPM", readings: 1, assetCount: 1, minimum: 2000, maximum: 2000, average: 2000 }
    ]);
  });

  it("rejects an empty fleet", async () => {
    await assert.rejects(() => inspectFleet({ assets: [] }), /between 1 and 20 assets/);
  });

  it("keeps limited fleet output valid JSON", async () => {
    const inspection = await inspectFleet(
      { assets: [{ name: "Pump A", url: "https://example.com/pump-a" }] },
      async ({ url }) =>
        snapshot(url, "Critical vibration failure at 14 mm/s. Replace the bearing immediately.")
    );
    const serialized = serializeFleetInspection(inspection, 500);

    assert.ok(serialized.length <= 500);
    assert.equal((JSON.parse(serialized) as { truncated: boolean }).truncated, true);
  });
});
