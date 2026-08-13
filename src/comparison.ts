import type { PageSnapshot } from "./browser.js";
import {
  buildDiagnosticReport,
  type DiagnosticFinding,
  type Measurement
} from "./extractors.js";

export interface SignalState {
  signal: string;
  severity: DiagnosticFinding["severity"];
  evidence: string;
}

export interface SeverityChange {
  signal: string;
  baselineSeverity: DiagnosticFinding["severity"];
  currentSeverity: DiagnosticFinding["severity"];
  baselineEvidence: string;
  currentEvidence: string;
}

export interface MeasurementChange {
  context: string;
  unit: string;
  baselineValue?: number;
  currentValue?: number;
  absoluteChange?: number;
  percentChange?: number;
  change: "added" | "removed" | "changed";
}

export interface DiagnosticComparison {
  baseline: PageIdentity;
  current: PageIdentity;
  summary: {
    addedSignals: number;
    resolvedSignals: number;
    severityEscalations: number;
    severityImprovements: number;
    measurementChanges: number;
    addedActions: number;
    removedActions: number;
  };
  addedSignals: SignalState[];
  resolvedSignals: SignalState[];
  severityChanges: SeverityChange[];
  measurementChanges: MeasurementChange[];
  actionChanges: { added: string[]; removed: string[] };
  headingChanges: { added: string[]; removed: string[] };
}

interface PageIdentity {
  url: string;
  title: string;
  status: number;
}

const severityRank: Record<DiagnosticFinding["severity"], number> = {
  info: 0,
  warning: 1,
  critical: 2
};

const contextualMeasurementPattern =
  /[-+]?(?:\d{1,3}(?:[ ,. ]\d{3})+|\d+)(?:[.,]\d+)?\s*(?:°\s?[cfk]|%|rpm|hz|khz|mm\/s|in\/s|m\/s²|m\/s2|g|bar|kpa|mpa|psi|pa|ma|a|kv|v|mv|°|db(?:a)?|μm|um|mm|cm)(?![\p{L}\p{N}_])/giu;

export function compareDiagnosticSnapshots(
  baselineSnapshot: PageSnapshot,
  currentSnapshot: PageSnapshot
): DiagnosticComparison {
  const baselineReport = buildDiagnosticReport(baselineSnapshot);
  const currentReport = buildDiagnosticReport(currentSnapshot);
  const baselineSignals = strongestSignals(baselineReport.findings);
  const currentSignals = strongestSignals(currentReport.findings);

  const addedSignals = Array.from(currentSignals.values()).filter(
    ({ signal }) => !baselineSignals.has(signal)
  );
  const resolvedSignals = Array.from(baselineSignals.values()).filter(
    ({ signal }) => !currentSignals.has(signal)
  );
  const severityChanges = Array.from(currentSignals.values()).flatMap((current) => {
    const baseline = baselineSignals.get(current.signal);
    if (!baseline || baseline.severity === current.severity) return [];
    return [
      {
        signal: current.signal,
        baselineSeverity: baseline.severity,
        currentSeverity: current.severity,
        baselineEvidence: baseline.evidence,
        currentEvidence: current.evidence
      }
    ];
  });
  const measurementChanges = compareMeasurements(
    baselineReport.measurements,
    currentReport.measurements
  );
  const actionChanges = compareStrings(
    baselineReport.recommendedActions,
    currentReport.recommendedActions
  );
  const headingChanges = compareStrings(
    baselineSnapshot.headings.map(formatHeading),
    currentSnapshot.headings.map(formatHeading)
  );

  return {
    baseline: pageIdentity(baselineSnapshot),
    current: pageIdentity(currentSnapshot),
    summary: {
      addedSignals: addedSignals.length,
      resolvedSignals: resolvedSignals.length,
      severityEscalations: severityChanges.filter(
        (change) => severityRank[change.currentSeverity] > severityRank[change.baselineSeverity]
      ).length,
      severityImprovements: severityChanges.filter(
        (change) => severityRank[change.currentSeverity] < severityRank[change.baselineSeverity]
      ).length,
      measurementChanges: measurementChanges.length,
      addedActions: actionChanges.added.length,
      removedActions: actionChanges.removed.length
    },
    addedSignals,
    resolvedSignals,
    severityChanges,
    measurementChanges,
    actionChanges,
    headingChanges
  };
}

function pageIdentity(snapshot: PageSnapshot): PageIdentity {
  return { url: snapshot.url, title: snapshot.title, status: snapshot.status };
}

function strongestSignals(findings: DiagnosticFinding[]): Map<string, SignalState> {
  const signals = new Map<string, SignalState>();
  for (const finding of findings) {
    const current = signals.get(finding.signal);
    if (!current || severityRank[finding.severity] > severityRank[current.severity]) {
      signals.set(finding.signal, {
        signal: finding.signal,
        severity: finding.severity,
        evidence: finding.evidence
      });
    }
  }
  return signals;
}

function compareMeasurements(
  baselineMeasurements: Measurement[],
  currentMeasurements: Measurement[]
): MeasurementChange[] {
  const changes: MeasurementChange[] = [];
  const matchedCurrent = new Set<number>();

  for (const baselineMeasurement of baselineMeasurements) {
    const matchIndex = findMeasurementMatch(
      baselineMeasurement,
      currentMeasurements,
      matchedCurrent
    );
    if (matchIndex === undefined) {
      changes.push({
        context: measurementContext(baselineMeasurement),
        unit: baselineMeasurement.unit,
        baselineValue: baselineMeasurement.value,
        change: "removed"
      });
      continue;
    }

    matchedCurrent.add(matchIndex);
    const currentMeasurement = currentMeasurements[matchIndex];
    if (baselineMeasurement.value === currentMeasurement.value) continue;
    changes.push({
      context: measurementContext(currentMeasurement),
      unit: currentMeasurement.unit,
      baselineValue: baselineMeasurement.value,
      currentValue: currentMeasurement.value,
      absoluteChange: round(currentMeasurement.value - baselineMeasurement.value),
      percentChange:
        baselineMeasurement.value === 0
          ? undefined
          : round(
              ((currentMeasurement.value - baselineMeasurement.value) /
                Math.abs(baselineMeasurement.value)) *
                100
            ),
      change: "changed"
    });
  }

  currentMeasurements.forEach((measurement, index) => {
    if (matchedCurrent.has(index)) return;
    changes.push({
      context: measurementContext(measurement),
      unit: measurement.unit,
      currentValue: measurement.value,
      change: "added"
    });
  });

  return changes;
}

function findMeasurementMatch(
  baseline: Measurement,
  currentMeasurements: Measurement[],
  matchedCurrent: Set<number>
): number | undefined {
  const baselineContext = canonicalMeasurementContext(baseline);
  let bestIndex: number | undefined;
  let bestScore = 0;

  for (let index = 0; index < currentMeasurements.length; index += 1) {
    const current = currentMeasurements[index];
    if (matchedCurrent.has(index) || current.unit !== baseline.unit) continue;
    const currentContext = canonicalMeasurementContext(current);
    if (currentContext === baselineContext) return index;
    const score = contextSimilarity(baselineContext, currentContext);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }

  return bestScore >= 0.4 ? bestIndex : undefined;
}

function measurementContext(measurement: Measurement): string {
  return measurement.evidence
    .replace(contextualMeasurementPattern, "<reading>")
    .replace(/\s+/g, " ")
    .trim();
}

function canonicalMeasurementContext(measurement: Measurement): string {
  return measurementContext(measurement)
    .toLowerCase()
    .replace(/\b(?:critical|danger|failure|failed|severe|warning|alarm)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function contextSimilarity(left: string, right: string): number {
  const ignored = new Set(["a", "an", "at", "is", "of", "reading", "the", "to", "was"]);
  const tokens = (value: string): Set<string> =>
    new Set(
      value
        .split(/[^\p{L}\p{N}]+/u)
        .filter((token) => token.length > 1 && !ignored.has(token))
    );
  const leftTokens = tokens(left);
  const rightTokens = tokens(right);
  const union = new Set([...leftTokens, ...rightTokens]);
  if (union.size === 0) return 0;
  const intersection = Array.from(leftTokens).filter((token) => rightTokens.has(token)).length;
  return intersection / union.size;
}

function compareStrings(
  baselineValues: string[],
  currentValues: string[]
): { added: string[]; removed: string[] } {
  const baseline = new Map(baselineValues.map((value) => [normalize(value), value]));
  const current = new Map(currentValues.map((value) => [normalize(value), value]));
  return {
    added: Array.from(current.entries())
      .filter(([key]) => !baseline.has(key))
      .map(([, value]) => value),
    removed: Array.from(baseline.entries())
      .filter(([key]) => !current.has(key))
      .map(([, value]) => value)
  };
}

function formatHeading(heading: PageSnapshot["headings"][number]): string {
  return `${"#".repeat(heading.level)} ${heading.text}`;
}

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function round(value: number): number {
  return Number(value.toFixed(4));
}
