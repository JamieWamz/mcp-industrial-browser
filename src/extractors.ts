import type { PageSnapshot } from "./browser.js";

export interface DiagnosticFinding {
  signal: string;
  severity: "info" | "warning" | "critical";
  evidence: string;
  source: "text" | "table";
}

export interface Measurement {
  value: number;
  unit: string;
  evidence: string;
}

export interface DiagnosticReport {
  findings: DiagnosticFinding[];
  measurements: Measurement[];
  recommendedActions: string[];
  severityCounts: Record<DiagnosticFinding["severity"], number>;
}

const diagnosticPatterns: Array<{
  signal: string;
  severity: DiagnosticFinding["severity"];
  pattern: RegExp;
}> = [
  {
    signal: "temperature anomaly",
    severity: "warning",
    pattern: /\b(overheat(?:ing|ed)?|temperature|thermal|hot bearing|heat damage)\b/i
  },
  {
    signal: "vibration anomaly",
    severity: "warning",
    pattern: /\b(vibration|misalignment|imbalance|unbalance|bearing wear|looseness|resonance)\b/i
  },
  {
    signal: "pressure or flow anomaly",
    severity: "warning",
    pattern: /\b(pressure|vacuum|leak(?:age)?|rupture|flow rate|cavitation)\b/i
  },
  {
    signal: "lubrication issue",
    severity: "warning",
    pattern: /\b(lubrication|lubricant|oil|grease|viscosity|contamination|debris)\b/i
  },
  {
    signal: "electrical fault",
    severity: "critical",
    pattern: /\b(arc flash|short circuit|insulation failure|overcurrent|ground fault|phase imbalance)\b/i
  },
  {
    signal: "shutdown condition",
    severity: "critical",
    pattern: /\b(shutdown|trip(?:ped)?|lockout|emergency stop|fatal alarm|machine stop)\b/i
  },
  {
    signal: "maintenance action",
    severity: "info",
    pattern: /\b(inspect|replace|calibrate|service|maintenance|clean|tighten|lubricate)\b/i
  }
];

const criticalContext = /\b(critical|danger|failure|failed|immediate(?:ly)?|emergency|severe)\b/i;
const measurementPattern =
  /([-+]?(?:\d{1,3}(?:[ ,]\d{3})+|\d+)(?:[.,]\d+)?)\s*(°\s?[cfk]|%|rpm|hz|khz|mm\/s|in\/s|m\/s²|m\/s2|g|bar|kpa|mpa|psi|pa|ma|a|kv|v|mv|°|db(?:a)?|μm|um|mm|cm)(?![\p{L}\p{N}_])/giu;
const actionPattern =
  /\b(?:inspect|replace|calibrate|service|clean|tighten|lubricate|monitor|verify|check|repair)\b[^.!?]*(?:[.!?]|$)/gi;

export function buildDiagnosticReport(snapshot: PageSnapshot): DiagnosticReport {
  const findings = extractDiagnostics(snapshot);
  return {
    findings,
    measurements: extractMeasurements(snapshot),
    recommendedActions: extractRecommendedActions(snapshot),
    severityCounts: findings.reduce<Record<DiagnosticFinding["severity"], number>>(
      (counts, finding) => {
        counts[finding.severity] += 1;
        return counts;
      },
      { info: 0, warning: 0, critical: 0 }
    )
  };
}

export function extractDiagnostics(snapshot: PageSnapshot): DiagnosticFinding[] {
  const sources = [
    ...splitSentences(snapshot.text).map((evidence) => ({ evidence, source: "text" as const })),
    ...tableEvidence(snapshot).map((evidence) => ({ evidence, source: "table" as const }))
  ];
  const findings: DiagnosticFinding[] = [];
  const seen = new Set<string>();

  for (const { evidence, source } of sources) {
    for (const diagnosticPattern of diagnosticPatterns) {
      if (!diagnosticPattern.pattern.test(evidence)) continue;
      const severity =
        diagnosticPattern.severity !== "info" && criticalContext.test(evidence)
          ? "critical"
          : diagnosticPattern.severity;
      const key = `${diagnosticPattern.signal}\0${evidence.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({ signal: diagnosticPattern.signal, severity, evidence, source });
    }
  }

  return findings.slice(0, 100);
}

export function extractMeasurements(snapshot: PageSnapshot): Measurement[] {
  const evidenceItems = [...splitSentences(snapshot.text), ...tableEvidence(snapshot)];
  const measurements: Measurement[] = [];
  const seen = new Set<string>();

  for (const evidence of evidenceItems) {
    measurementPattern.lastIndex = 0;
    for (const match of evidence.matchAll(measurementPattern)) {
      const value = parseNumericValue(match[1]);
      const unit = normalizeUnit(match[2]);
      const key = `${value}\0${unit}\0${evidence.toLowerCase()}`;
      if (!Number.isFinite(value) || seen.has(key)) continue;
      seen.add(key);
      measurements.push({ value, unit, evidence });
      if (measurements.length >= 100) return measurements;
    }
  }

  return measurements;
}

export function extractRecommendedActions(snapshot: PageSnapshot): string[] {
  const evidenceItems = [...splitSentences(snapshot.text), ...tableEvidence(snapshot)];
  const actions = evidenceItems.flatMap((evidence) => evidence.match(actionPattern) ?? []);
  return unique(actions.map(cleanEvidence)).filter((action) => action.length >= 12).slice(0, 30);
}

export function serializeDiagnosticReport(snapshot: PageSnapshot, maxCharacters: number): string {
  const report = buildDiagnosticReport(snapshot);
  const payload = {
    source: {
      url: snapshot.url,
      title: snapshot.title,
      status: snapshot.status
    },
    ...report,
    tableCount: snapshot.tables.length,
    linkCount: snapshot.links.length
  };
  let serialized = JSON.stringify(payload, null, 2);
  if (serialized.length <= maxCharacters) return serialized;

  const limited = {
    ...payload,
    findings: [...payload.findings],
    measurements: [...payload.measurements],
    recommendedActions: [...payload.recommendedActions],
    truncated: true
  };
  const arrays = [limited.findings, limited.measurements, limited.recommendedActions];

  while (serialized.length > maxCharacters && arrays.some((items) => items.length > 0)) {
    const longest = arrays.reduce((selected, items) =>
      JSON.stringify(items.at(-1) ?? "").length > JSON.stringify(selected.at(-1) ?? "").length
        ? items
        : selected
    );
    longest.pop();
    serialized = JSON.stringify(limited, null, 2);
  }

  if (serialized.length <= maxCharacters) return serialized;

  const fallback = JSON.stringify({
    source: {
      url: truncate(snapshot.url, 120),
      title: truncate(snapshot.title, 80),
      status: snapshot.status
    },
    severityCounts: report.severityCounts,
    tableCount: snapshot.tables.length,
    linkCount: snapshot.links.length,
    truncated: true
  });
  return fallback.length <= maxCharacters ? fallback : JSON.stringify({ truncated: true });
}

export function summarizeSnapshot(snapshot: PageSnapshot, maxCharacters: number): string {
  const sections = [
    `Title: ${snapshot.title || "Untitled"}`,
    `URL: ${snapshot.url}`,
    `HTTP status: ${snapshot.status || "unknown"}`,
    snapshot.description ? `Description: ${snapshot.description}` : "",
    snapshot.headings.length > 0
      ? `Headings:\n${snapshot.headings.map((heading) => `${"#".repeat(heading.level)} ${heading.text}`).join("\n")}`
      : "",
    `Text: ${snapshot.text}`
  ].filter(Boolean);

  if (snapshot.tables.length > 0) {
    sections.push(`Tables: ${JSON.stringify(snapshot.tables.slice(0, 5))}`);
  }

  return truncate(sections.join("\n\n"), maxCharacters);
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\s*[\r\n]+\s*/)
    .map(cleanEvidence)
    .filter(Boolean);
}

function tableEvidence(snapshot: PageSnapshot): string[] {
  return snapshot.tables.flatMap((table) =>
    table.rows.map((row) => {
      if (table.headers.length === row.length) {
        return row.map((cell, index) => `${table.headers[index]}: ${cell}`).join("; ");
      }
      return row.join("; ");
    })
  );
}

function normalizeUnit(value: string): string {
  return value.replace(/\s+/g, "").replace(/^°([cfk])$/i, "°$1").toUpperCase();
}

function parseNumericValue(value: string): number {
  const compact = value.replace(/\s+/g, "");
  if (/^[+-]?\d{1,3}(?:,\d{3})+$/.test(compact)) {
    return Number(compact.replace(/,/g, ""));
  }
  if (compact.includes(",") && compact.includes(".")) {
    const decimalSeparator = compact.lastIndexOf(",") > compact.lastIndexOf(".") ? "," : ".";
    const groupingSeparator = decimalSeparator === "," ? "." : ",";
    return Number(compact.replaceAll(groupingSeparator, "").replace(decimalSeparator, "."));
  }
  return Number(compact.replace(",", "."));
}

function cleanEvidence(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.toLowerCase()))).map(
    (normalized) => values.find((value) => value.toLowerCase() === normalized) ?? normalized
  );
}

function truncate(value: string, maxCharacters: number): string {
  if (value.length <= maxCharacters) return value;
  return `${value.slice(0, Math.max(0, maxCharacters - 3))}...`;
}
