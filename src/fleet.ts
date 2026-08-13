import { fetchPage, type FetchPageOptions, type PageSnapshot } from "./browser.js";
import {
  buildDiagnosticReport,
  type DiagnosticFinding,
  type DiagnosticReport,
  type Measurement
} from "./extractors.js";

export interface FleetAsset {
  name: string;
  url: string;
}

export interface FleetInspectionOptions extends Pick<FetchPageOptions, "timeoutMs" | "waitUntil"> {
  assets: FleetAsset[];
  concurrency?: number;
}

export interface AssetAssessment {
  asset: FleetAsset;
  source: { url: string; title: string; status: number };
  riskScore: number;
  healthScore: number;
  riskLevel: RiskLevel;
  severityCounts: DiagnosticReport["severityCounts"];
  signals: Array<{
    signal: string;
    severity: DiagnosticFinding["severity"];
    evidence: string;
  }>;
  measurements: Measurement[];
  recommendedActions: string[];
}

export interface AssetFailure {
  asset: FleetAsset;
  error: string;
}

export interface FleetInspection {
  summary: {
    requested: number;
    succeeded: number;
    failed: number;
    averageHealthScore: number | null;
    riskCounts: Record<RiskLevel, number>;
    severityCounts: DiagnosticReport["severityCounts"];
  };
  assets: AssetAssessment[];
  failures: AssetFailure[];
  signalFrequency: Array<{ signal: string; assetCount: number }>;
  actionFrequency: Array<{ action: string; assetCount: number }>;
  measurementRanges: Array<{
    unit: string;
    readings: number;
    assetCount: number;
    minimum: number;
    maximum: number;
    average: number;
  }>;
}

type RiskLevel = "low" | "medium" | "high" | "critical";
type PageFetcher = (options: FetchPageOptions) => Promise<PageSnapshot>;

const severityWeight: Record<DiagnosticFinding["severity"], number> = {
  info: 2,
  warning: 12,
  critical: 30
};

export async function inspectFleet(
  options: FleetInspectionOptions,
  pageFetcher: PageFetcher = fetchPage
): Promise<FleetInspection> {
  if (options.assets.length === 0 || options.assets.length > 20) {
    throw new Error("Fleet inspection requires between 1 and 20 assets");
  }
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 3, 5, options.assets.length));
  const results = new Array<AssetAssessment | AssetFailure>(options.assets.length);
  let nextIndex = 0;

  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= options.assets.length) return;
      const asset = options.assets[index];

      try {
        const snapshot = await pageFetcher({
          url: asset.url,
          timeoutMs: options.timeoutMs,
          waitUntil: options.waitUntil
        });
        results[index] = assessAsset(asset, snapshot);
      } catch (error: unknown) {
        results[index] = { asset, error: errorMessage(error) };
      }
    }
  });
  await Promise.all(workers);

  const assets = results.filter(isAssessment).sort(compareRisk);
  const failures = results.filter(isFailure);
  return aggregateFleet(options.assets.length, assets, failures);
}

export function assessAsset(asset: FleetAsset, snapshot: PageSnapshot): AssetAssessment {
  const report = buildDiagnosticReport(snapshot);
  const signals = strongestSignals(report.findings);
  const riskScore = Math.min(
    100,
    signals.reduce((score, finding) => score + severityWeight[finding.severity], 0)
  );

  return {
    asset,
    source: { url: snapshot.url, title: snapshot.title, status: snapshot.status },
    riskScore,
    healthScore: 100 - riskScore,
    riskLevel: riskLevel(riskScore, signals),
    severityCounts: report.severityCounts,
    signals,
    measurements: report.measurements,
    recommendedActions: report.recommendedActions
  };
}

export function serializeFleetInspection(
  inspection: FleetInspection,
  maxCharacters: number
): string {
  let serialized = JSON.stringify(inspection, null, 2);
  if (serialized.length <= maxCharacters) return serialized;

  const limited = structuredClone(inspection) as FleetInspection & { truncated: true };
  limited.truncated = true;
  const removable = limited.assets.flatMap((asset) => [
    asset.measurements,
    asset.recommendedActions,
    asset.signals
  ]);

  while (serialized.length > maxCharacters && removable.some((items) => items.length > 0)) {
    const longest = removable.reduce((selected, items) =>
      JSON.stringify(items.at(-1) ?? "").length > JSON.stringify(selected.at(-1) ?? "").length
        ? items
        : selected
    );
    longest.pop();
    serialized = JSON.stringify(limited, null, 2);
  }
  if (serialized.length <= maxCharacters) return serialized;

  const compact = JSON.stringify({
    summary: inspection.summary,
    ranking: inspection.assets.map(({ asset, riskScore, healthScore, riskLevel }) => ({
      asset,
      riskScore,
      healthScore,
      riskLevel
    })),
    failures: inspection.failures,
    truncated: true
  });
  return compact.length <= maxCharacters ? compact : JSON.stringify({ truncated: true });
}

function aggregateFleet(
  requested: number,
  assets: AssetAssessment[],
  failures: AssetFailure[]
): FleetInspection {
  const signalAssets = new Map<string, Set<string>>();
  const actions = new Map<string, { action: string; assets: Set<string> }>();
  const measurements = new Map<string, { values: number[]; assets: Set<string> }>();
  const riskCounts: Record<RiskLevel, number> = { low: 0, medium: 0, high: 0, critical: 0 };
  const severityCounts: DiagnosticReport["severityCounts"] = { info: 0, warning: 0, critical: 0 };

  for (const assessment of assets) {
    riskCounts[assessment.riskLevel] += 1;
    for (const severity of Object.keys(severityCounts) as Array<keyof typeof severityCounts>) {
      severityCounts[severity] += assessment.severityCounts[severity];
    }
    for (const { signal } of assessment.signals) {
      const assetNames = signalAssets.get(signal) ?? new Set<string>();
      assetNames.add(assessment.asset.name);
      signalAssets.set(signal, assetNames);
    }
    for (const action of assessment.recommendedActions) {
      const key = normalize(action);
      const entry = actions.get(key) ?? { action, assets: new Set<string>() };
      entry.assets.add(assessment.asset.name);
      actions.set(key, entry);
    }
    for (const measurement of assessment.measurements) {
      const entry = measurements.get(measurement.unit) ?? {
        values: [],
        assets: new Set<string>()
      };
      entry.values.push(measurement.value);
      entry.assets.add(assessment.asset.name);
      measurements.set(measurement.unit, entry);
    }
  }

  return {
    summary: {
      requested,
      succeeded: assets.length,
      failed: failures.length,
      averageHealthScore:
        assets.length === 0
          ? null
          : round(assets.reduce((total, asset) => total + asset.healthScore, 0) / assets.length),
      riskCounts,
      severityCounts
    },
    assets,
    failures,
    signalFrequency: Array.from(signalAssets, ([signal, names]) => ({
      signal,
      assetCount: names.size
    })).sort(compareFrequency),
    actionFrequency: Array.from(actions.values(), ({ action, assets: names }) => ({
      action,
      assetCount: names.size
    })).sort(compareFrequency),
    measurementRanges: Array.from(measurements, ([unit, entry]) => ({
      unit,
      readings: entry.values.length,
      assetCount: entry.assets.size,
      minimum: Math.min(...entry.values),
      maximum: Math.max(...entry.values),
      average: round(entry.values.reduce((total, value) => total + value, 0) / entry.values.length)
    })).sort((a, b) => a.unit.localeCompare(b.unit))
  };
}

function strongestSignals(findings: DiagnosticFinding[]): AssetAssessment["signals"] {
  const rank: Record<DiagnosticFinding["severity"], number> = { info: 0, warning: 1, critical: 2 };
  const signals = new Map<string, AssetAssessment["signals"][number]>();
  for (const finding of findings) {
    const current = signals.get(finding.signal);
    if (!current || rank[finding.severity] > rank[current.severity]) {
      signals.set(finding.signal, {
        signal: finding.signal,
        severity: finding.severity,
        evidence: finding.evidence
      });
    }
  }
  return Array.from(signals.values());
}

function riskLevel(score: number, signals: AssetAssessment["signals"]): RiskLevel {
  if (signals.some(({ severity }) => severity === "critical")) return "critical";
  if (score >= 36) return "high";
  if (score >= 12) return "medium";
  return "low";
}

function compareRisk(a: AssetAssessment, b: AssetAssessment): number {
  return b.riskScore - a.riskScore || a.asset.name.localeCompare(b.asset.name);
}

function compareFrequency(
  a: { assetCount: number; signal?: string; action?: string },
  b: { assetCount: number; signal?: string; action?: string }
): number {
  return (
    b.assetCount - a.assetCount ||
    (a.signal ?? a.action ?? "").localeCompare(b.signal ?? b.action ?? "")
  );
}

function isAssessment(result: AssetAssessment | AssetFailure): result is AssetAssessment {
  return "source" in result;
}

function isFailure(result: AssetAssessment | AssetFailure): result is AssetFailure {
  return "error" in result;
}

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function round(value: number): number {
  return Number(value.toFixed(2));
}
