import { randomUUID } from "node:crypto";

export type MetricLabels = Readonly<Record<string, string>>;
export type MetricKind = "counter" | "gauge" | "histogram";

const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function labelKey(labels: MetricLabels): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length > 12) throw new Error("TOO_MANY_METRIC_LABELS");
  for (const [name, value] of entries) {
    if (!LABEL_NAME.test(name) || value.length > 96) throw new Error("INVALID_METRIC_LABEL");
  }
  return entries.map(([name, value]) => `${name}=${value}`).join("\u0000");
}

function renderLabels(labels: MetricLabels): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  return entries.length === 0 ? "" : `{${entries.map(([name, value]) => `${name}="${escapeLabel(value)}"`).join(",")}}`;
}

interface Series { labels: MetricLabels; value: number }
interface HistogramSeries {
  labels: MetricLabels;
  buckets: number[];
  counts: number[];
  count: number;
  sum: number;
}

export class MetricsRegistry {
  private readonly counters = new Map<string, { help: string; series: Map<string, Series> }>();
  private readonly gauges = new Map<string, { help: string; series: Map<string, Series> }>();
  private readonly histograms = new Map<string, { help: string; buckets: number[]; series: Map<string, HistogramSeries> }>();
  private readonly maxSeriesPerMetric: number;

  constructor(maxSeriesPerMetric = 500) {
    if (!Number.isSafeInteger(maxSeriesPerMetric) || maxSeriesPerMetric < 1 || maxSeriesPerMetric > 10_000) throw new Error("INVALID_SERIES_LIMIT");
    this.maxSeriesPerMetric = maxSeriesPerMetric;
  }

  counter(name: string, help: string): { add: (amount?: number, labels?: MetricLabels) => void } {
    this.metricName(name);
    const metric = this.counters.get(name) ?? { help, series: new Map<string, Series>() };
    this.counters.set(name, metric);
    return {
      add: (amount = 1, labels = {}) => {
        if (!Number.isFinite(amount) || amount < 0) throw new Error("INVALID_COUNTER_INCREMENT");
        const series = this.series(metric.series, labels);
        series.value += amount;
      },
    };
  }

  gauge(name: string, help: string): { set: (value: number, labels?: MetricLabels) => void; add: (amount: number, labels?: MetricLabels) => void } {
    this.metricName(name);
    const metric = this.gauges.get(name) ?? { help, series: new Map<string, Series>() };
    this.gauges.set(name, metric);
    return {
      set: (value, labels = {}) => {
        if (!Number.isFinite(value)) throw new Error("INVALID_GAUGE_VALUE");
        this.series(metric.series, labels).value = value;
      },
      add: (amount, labels = {}) => {
        if (!Number.isFinite(amount)) throw new Error("INVALID_GAUGE_VALUE");
        this.series(metric.series, labels).value += amount;
      },
    };
  }

  histogram(name: string, help: string, buckets: readonly number[]): { observe: (value: number, labels?: MetricLabels) => void } {
    this.metricName(name);
    const normalized = [...new Set(buckets)].sort((a, b) => a - b);
    if (normalized.length === 0 || normalized.some((value) => !Number.isFinite(value) || value <= 0)) throw new Error("INVALID_HISTOGRAM_BUCKETS");
    const existing = this.histograms.get(name);
    if (existing && existing.buckets.join(",") !== normalized.join(",")) throw new Error("HISTOGRAM_BUCKET_MISMATCH");
    const metric = existing ?? { help, buckets: normalized, series: new Map<string, HistogramSeries>() };
    this.histograms.set(name, metric);
    return {
      observe: (value, labels = {}) => {
        if (!Number.isFinite(value) || value < 0) throw new Error("INVALID_HISTOGRAM_VALUE");
        const key = labelKey(labels);
        let series = metric.series.get(key);
        if (!series) {
          if (metric.series.size >= this.maxSeriesPerMetric) throw new Error("METRIC_SERIES_LIMIT");
          series = { labels: { ...labels }, buckets: [...normalized], counts: normalized.map(() => 0), count: 0, sum: 0 };
          metric.series.set(key, series);
        }
        series.count += 1;
        series.sum += value;
        for (let index = 0; index < normalized.length; index += 1) if (value <= normalized[index]!) series.counts[index]! += 1;
      },
    };
  }

  renderPrometheus(): string {
    const lines: string[] = [];
    for (const [name, metric] of [...this.counters].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`# HELP ${name} ${metric.help}`, `# TYPE ${name} counter`);
      for (const series of metric.series.values()) lines.push(`${name}${renderLabels(series.labels)} ${series.value}`);
    }
    for (const [name, metric] of [...this.gauges].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`# HELP ${name} ${metric.help}`, `# TYPE ${name} gauge`);
      for (const series of metric.series.values()) lines.push(`${name}${renderLabels(series.labels)} ${series.value}`);
    }
    for (const [name, metric] of [...this.histograms].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`# HELP ${name} ${metric.help}`, `# TYPE ${name} histogram`);
      for (const series of metric.series.values()) {
        for (let index = 0; index < series.buckets.length; index += 1) {
          lines.push(`${name}_bucket${renderLabels({ ...series.labels, le: String(series.buckets[index]) })} ${series.counts[index]}`);
        }
        lines.push(`${name}_bucket${renderLabels({ ...series.labels, le: "+Inf" })} ${series.count}`);
        lines.push(`${name}_sum${renderLabels(series.labels)} ${series.sum}`);
        lines.push(`${name}_count${renderLabels(series.labels)} ${series.count}`);
      }
    }
    return `${lines.join("\n")}\n`;
  }

  private metricName(name: string): void {
    if (!METRIC_NAME.test(name)) throw new Error("INVALID_METRIC_NAME");
  }

  private series(map: Map<string, Series>, labels: MetricLabels): Series {
    const key = labelKey(labels);
    let series = map.get(key);
    if (!series) {
      if (map.size >= this.maxSeriesPerMetric) throw new Error("METRIC_SERIES_LIMIT");
      series = { labels: { ...labels }, value: 0 };
      map.set(key, series);
    }
    return series;
  }
}

export interface TraceContext { traceId: string; spanId: string; parentSpanId?: string }

export function traceContext(traceId?: string, parentSpanId?: string): TraceContext {
  const normalizedTrace = traceId && /^[0-9a-f]{32}$/i.test(traceId) ? traceId.toLowerCase() : randomUUID().replace(/-/g, "");
  const spanId = randomUUID().replace(/-/g, "").slice(0, 16);
  return parentSpanId ? { traceId: normalizedTrace, spanId, parentSpanId } : { traceId: normalizedTrace, spanId };
}

export function structuredLog(level: "debug" | "info" | "warn" | "error", event: string, fields: Record<string, unknown> = {}): string {
  if (!/^[a-z0-9][a-z0-9._-]{1,100}$/.test(event)) throw new Error("INVALID_LOG_EVENT");
  const redacted = JSON.parse(JSON.stringify(fields, (key, value) => /token|secret|password|authorization|cookie/i.test(key) ? "[REDACTED]" : value));
  return JSON.stringify({ level, event, at: new Date().toISOString(), ...redacted });
}
