import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PageSnapshot } from "../src/browser.js";
import { compareDiagnosticSnapshots } from "../src/comparison.js";

function snapshot(overrides: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    url: "https://example.com/manual",
    title: "Pump diagnostics",
    description: "",
    status: 200,
    contentType: "text/html",
    text: "",
    headings: [],
    links: [],
    tables: [],
    ...overrides
  };
}

describe("diagnostic comparison", () => {
  it("finds signal, severity, measurement, action, and heading changes", () => {
    const baseline = snapshot({
      url: "https://example.com/baseline",
      text: "Bearing vibration is 4 mm/s. Inspect the coupling every month. Oil contamination was detected.",
      headings: [{ level: 1, text: "Routine maintenance" }]
    });
    const current = snapshot({
      url: "https://example.com/current",
      text: "Critical bearing vibration failure is 10 mm/s. Replace the bearing immediately. Temperature is 85 °C.",
      headings: [{ level: 1, text: "Emergency maintenance" }]
    });

    const comparison = compareDiagnosticSnapshots(baseline, current);

    assert.deepEqual(comparison.summary, {
      addedSignals: 1,
      resolvedSignals: 1,
      severityEscalations: 1,
      severityImprovements: 0,
      measurementChanges: 2,
      addedActions: 1,
      removedActions: 1
    });
    assert.deepEqual(
      comparison.addedSignals.map(({ signal, severity }) => ({ signal, severity })),
      [{ signal: "temperature anomaly", severity: "warning" }]
    );
    assert.deepEqual(
      comparison.resolvedSignals.map(({ signal }) => signal),
      ["lubrication issue"]
    );
    assert.deepEqual(comparison.severityChanges[0], {
      signal: "vibration anomaly",
      baselineSeverity: "warning",
      currentSeverity: "critical",
      baselineEvidence: "Bearing vibration is 4 mm/s.",
      currentEvidence: "Critical bearing vibration failure is 10 mm/s."
    });
    assert.deepEqual(comparison.measurementChanges, [
      {
        context: "Critical bearing vibration failure is <reading>.",
        unit: "MM/S",
        baselineValue: 4,
        currentValue: 10,
        absoluteChange: 6,
        percentChange: 150,
        change: "changed"
      },
      {
        context: "Temperature is <reading>.",
        unit: "°C",
        currentValue: 85,
        change: "added"
      }
    ]);
    assert.deepEqual(comparison.headingChanges, {
      added: ["# Emergency maintenance"],
      removed: ["# Routine maintenance"]
    });
  });

  it("matches the same measurement context and calculates its delta", () => {
    const comparison = compareDiagnosticSnapshots(
      snapshot({ text: "Bearing A vibration is 5 mm/s." }),
      snapshot({ text: "Bearing A vibration is 7.5 mm/s." })
    );

    assert.deepEqual(comparison.measurementChanges, [
      {
        context: "Bearing A vibration is <reading>.",
        unit: "MM/S",
        baselineValue: 5,
        currentValue: 7.5,
        absoluteChange: 2.5,
        percentChange: 50,
        change: "changed"
      }
    ]);
  });

  it("pairs readings when headings and severity wording change", () => {
    const comparison = compareDiagnosticSnapshots(
      snapshot({ text: "Routine maintenance Bearing vibration is 4 mm/s." }),
      snapshot({ text: "Alarm response Critical bearing vibration failure is 10 mm/s." })
    );

    assert.deepEqual(comparison.measurementChanges, [
      {
        context: "Alarm response Critical bearing vibration failure is <reading>.",
        unit: "MM/S",
        baselineValue: 4,
        currentValue: 10,
        absoluteChange: 6,
        percentChange: 150,
        change: "changed"
      }
    ]);
  });

  it("reports severity improvements", () => {
    const comparison = compareDiagnosticSnapshots(
      snapshot({ text: "Critical temperature failure reached 95 °C." }),
      snapshot({ text: "Temperature stabilized at 70 °C." })
    );

    assert.equal(comparison.summary.severityEscalations, 0);
    assert.equal(comparison.summary.severityImprovements, 1);
  });
});
