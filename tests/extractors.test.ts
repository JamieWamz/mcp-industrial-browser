import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PageSnapshot } from "../src/browser.js";
import {
  buildDiagnosticReport,
  extractDiagnostics,
  extractMeasurements,
  serializeDiagnosticReport,
  summarizeSnapshot
} from "../src/extractors.js";

function snapshot(overrides: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    url: "https://example.com/manual",
    title: "Pump maintenance",
    description: "Service instructions",
    status: 200,
    contentType: "text/html",
    text: "",
    headings: [],
    links: [],
    tables: [],
    ...overrides
  };
}

describe("diagnostic extraction", () => {
  it("finds multiple signals in one sentence and escalates critical context", () => {
    const findings = extractDiagnostics(
      snapshot({ text: "Critical bearing vibration and temperature indicate severe failure." })
    );

    assert.deepEqual(
      findings.map(({ signal, severity }) => ({ signal, severity })),
      [
        { signal: "temperature anomaly", severity: "critical" },
        { signal: "vibration anomaly", severity: "critical" }
      ]
    );
  });

  it("extracts diagnostic evidence and readings from tables", () => {
    const report = buildDiagnosticReport(
      snapshot({
        text: "Inspect the motor immediately. Operating speed is 1450 rpm.",
        tables: [
          {
            headers: ["Sensor", "Reading", "Condition"],
            rows: [["Bearing A", "12.5 mm/s", "Critical vibration"]]
          }
        ]
      })
    );

    assert.ok(report.findings.some((finding) => finding.source === "table"));
    assert.ok(report.recommendedActions.some((action) => /inspect the motor/i.test(action)));
    assert.deepEqual(
      report.measurements.map(({ value, unit }) => ({ value, unit })),
      [
        { value: 1450, unit: "RPM" },
        { value: 12.5, unit: "MM/S" }
      ]
    );
  });

  it("deduplicates repeated measurements", () => {
    const measurements = extractMeasurements(snapshot({ text: "Temperature limit: 80 °C. Temperature limit: 80 °C." }));
    assert.equal(measurements.length, 1);
  });

  it("parses grouped numbers and units that do not end in letters", () => {
    const measurements = extractMeasurements(
      snapshot({ text: "Speed is 1,450 rpm. Load is 85%. Shaft angle is 90°. Acceleration is 2.5 m/s²." })
    );

    assert.deepEqual(
      measurements.map(({ value, unit }) => ({ value, unit })),
      [
        { value: 1450, unit: "RPM" },
        { value: 85, unit: "%" },
        { value: 90, unit: "°" },
        { value: 2.5, unit: "M/S²" }
      ]
    );
  });

  it("keeps truncated diagnostic reports valid JSON", () => {
    const report = serializeDiagnosticReport(
      snapshot({
        text: Array.from(
          { length: 20 },
          (_, index) => `Critical vibration failure ${index}. Inspect bearing assembly ${index} immediately.`
        ).join(" ")
      }),
      500
    );

    assert.ok(report.length <= 500);
    const parsed = JSON.parse(report) as { truncated?: boolean };
    assert.equal(parsed.truncated, true);
  });
});

describe("page summaries", () => {
  it("includes response metadata and respects the character limit", () => {
    const summary = summarizeSnapshot(
      snapshot({
        description: "A useful manual",
        headings: [{ level: 1, text: "Safety" }],
        text: "x".repeat(2000)
      }),
      500
    );

    assert.match(summary, /HTTP status: 200/);
    assert.match(summary, /# Safety/);
    assert.equal(summary.length, 500);
    assert.ok(summary.endsWith("..."));
  });
});
