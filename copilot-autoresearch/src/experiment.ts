import { spawn } from "node:child_process";
import { readFile, appendFile, access } from "node:fs/promises";
import path from "node:path";

import type {
  ExperimentConfig,
  ExperimentResult,
  ExperimentState,
  ExperimentStatus,
  MetricDirection,
  RunDetails,
} from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const JSONL_FILENAME = "autoresearch.jsonl";
const DEFAULT_TIMEOUT_S = 600;
const TAIL_MAX_LINES = 50;
const TAIL_MAX_BYTES = 4 * 1024;

const METRIC_REGEX = /^METRIC\s+([\w.µ]+)=(\S+)\s*$/gm;
const DENIED_METRIC_NAMES = new Set(["__proto__", "constructor", "prototype"]);

// ---------------------------------------------------------------------------
// Helpers – metrics
// ---------------------------------------------------------------------------

/** Parse `METRIC name=value` lines from process output. */
export function parseMetricLines(output: string): Map<string, number> {
  const metrics = new Map<string, number>();
  let match: RegExpExecArray | null;
  // Reset lastIndex since the regex has the global flag.
  METRIC_REGEX.lastIndex = 0;
  while ((match = METRIC_REGEX.exec(output)) !== null) {
    const name = match[1];
    if (DENIED_METRIC_NAMES.has(name)) continue;
    const value = Number(match[2]);
    if (Number.isFinite(value)) {
      metrics.set(name, value);
    }
  }
  return metrics;
}

/** Infer a display unit from a metric name suffix. */
export function inferUnit(metricName: string): string {
  if (metricName.endsWith("µs") || metricName.endsWith("_us")) return "µs";
  if (metricName.endsWith("_ms")) return "ms";
  if (metricName.endsWith("_s") || metricName.endsWith("_sec")) return "s";
  if (metricName.endsWith("_kb")) return "kb";
  if (metricName.endsWith("_mb")) return "mb";
  return "";
}

// ---------------------------------------------------------------------------
// Helpers – statistics
// ---------------------------------------------------------------------------

function sortedMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function isBetter(
  candidate: number,
  current: number,
  direction: MetricDirection,
): boolean {
  return direction === "lower" ? candidate < current : candidate > current;
}

/** Compute MAD-based confidence score for the current segment. */
export function computeConfidence(
  results: ExperimentResult[],
  segment: number,
  direction: MetricDirection,
): number | null {
  const cur = results.filter((r) => r.segment === segment && r.metric > 0);
  if (cur.length < 3) return null;

  const values = cur.map((r) => r.metric);
  const median = sortedMedian(values);
  const deviations = values.map((v) => Math.abs(v - median));
  const mad = sortedMedian(deviations);

  if (mad === 0) return null;

  // Baseline = first result in segment
  const baseline = cur[0].metric;

  // Best kept metric
  let bestKept: number | null = null;
  for (const r of cur) {
    if (r.status === "keep" && r.metric > 0) {
      if (bestKept === null || isBetter(r.metric, bestKept, direction)) {
        bestKept = r.metric;
      }
    }
  }
  if (bestKept === null || bestKept === baseline) return null;

  const delta = Math.abs(bestKept - baseline);
  return delta / mad;
}

// ---------------------------------------------------------------------------
// Helpers – tail output
// ---------------------------------------------------------------------------

function tailOutput(raw: string): string {
  const lines = raw.split("\n");
  let tail = lines.slice(-TAIL_MAX_LINES).join("\n");
  if (tail.length > TAIL_MAX_BYTES) {
    tail = tail.slice(-TAIL_MAX_BYTES);
  }
  return tail;
}

// ---------------------------------------------------------------------------
// JSONL persistence helpers
// ---------------------------------------------------------------------------

interface JsonlConfigLine {
  type: "config";
  name: string;
  metricName: string;
  metricUnit: string;
  bestDirection: MetricDirection;
}

interface JsonlResultLine {
  run: number;
  commit: string;
  metric: number;
  metrics: Record<string, number>;
  status: ExperimentStatus;
  description: string;
  timestamp: number;
  segment: number;
  confidence: number | null;
}

// ---------------------------------------------------------------------------
// ExperimentManager
// ---------------------------------------------------------------------------

export class ExperimentManager {
  private state: ExperimentState;
  private workDir: string;

  constructor(workDir?: string) {
    this.workDir = workDir ?? process.cwd();
    this.state = this.emptyState();
  }

  // -- Public API -----------------------------------------------------------

  /** Initialize (or reinitialize) an experiment session. */
  async initExperiment(config: ExperimentConfig): Promise<string> {
    const isReinit = this.state.results.length > 0;

    if (isReinit) {
      this.state.currentSegment += 1;
    }

    this.state.name = config.name;
    this.state.metricName = config.metricName;
    this.state.metricUnit = config.metricUnit || inferUnit(config.metricName);
    this.state.bestDirection = config.direction;
    this.state.bestMetric = null;

    // Persist config header
    const configLine: JsonlConfigLine = {
      type: "config",
      name: config.name,
      metricName: config.metricName,
      metricUnit: this.state.metricUnit,
      bestDirection: config.direction,
    };
    await this.appendJsonl(JSON.stringify(configLine));

    const dir = this.workDir;
    return [
      `✅ Experiment initialized${isReinit ? " (new segment)" : ""}`,
      `   Name:      ${config.name}`,
      `   Metric:    ${config.metricName}${this.state.metricUnit ? ` (${this.state.metricUnit})` : ""}`,
      `   Direction: ${config.direction} is better`,
      `   WorkDir:   ${dir}`,
      `   Segment:   ${this.state.currentSegment}`,
    ].join("\n");
  }

  /** Spawn a benchmark command, capture output, parse METRIC lines. */
  async runExperiment(
    command: string,
    timeoutSeconds?: number,
  ): Promise<RunDetails> {
    const timeout = timeoutSeconds ?? DEFAULT_TIMEOUT_S;

    return new Promise<RunDetails>((resolve) => {
      let stdout = "";
      let timedOut = false;

      const start = Date.now();

      const child = spawn("bash", ["-c", command], {
        cwd: this.workDir,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const timer = setTimeout(() => {
        timedOut = true;
        try {
          process.kill(-child.pid!, "SIGTERM");
        } catch {
          try {
            process.kill(child.pid!, "SIGTERM");
          } catch {
            /* already gone */
          }
        }
      }, timeout * 1000);

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        const durationSeconds =
          Math.round(((Date.now() - start) / 1000) * 10) / 10;
        const exitCode = timedOut ? null : code;
        const passed = !timedOut && code === 0;
        const crashed = !passed;

        let parsedMetrics: Record<string, number> | null = null;
        let parsedPrimary: number | null = null;

        if (passed) {
          const metricsMap = parseMetricLines(stdout);
          if (metricsMap.size > 0) {
            parsedMetrics = Object.fromEntries(metricsMap);
            parsedPrimary = metricsMap.get(this.state.metricName) ?? null;
          }
        }

        resolve({
          command,
          exitCode,
          durationSeconds,
          passed,
          crashed,
          timedOut,
          tailOutput: tailOutput(stdout),
          parsedMetrics,
          parsedPrimary,
          metricName: this.state.metricName,
          metricUnit: this.state.metricUnit,
        });
      });

      child.on("error", () => {
        clearTimeout(timer);
        const durationSeconds =
          Math.round(((Date.now() - start) / 1000) * 10) / 10;
        resolve({
          command,
          exitCode: null,
          durationSeconds,
          passed: false,
          crashed: true,
          timedOut: false,
          tailOutput: tailOutput(stdout),
          parsedMetrics: null,
          parsedPrimary: null,
          metricName: this.state.metricName,
          metricUnit: this.state.metricUnit,
        });
      });
    });
  }

  /** Record an experiment result (keep / discard / crash). */
  async logExperiment(params: {
    commit?: string;
    metric: number;
    status: ExperimentStatus;
    description: string;
    metrics?: Record<string, number>;
  }): Promise<string> {
    const confidence = computeConfidence(
      this.state.results,
      this.state.currentSegment,
      this.state.bestDirection,
    );

    const result: ExperimentResult = {
      commit: params.commit ?? "none",
      metric: params.metric,
      metrics: params.metrics ?? {},
      status: params.status,
      description: params.description,
      timestamp: Date.now(),
      segment: this.state.currentSegment,
      confidence,
    };

    this.state.results.push(result);

    // Update best metric for keeps
    if (
      result.status === "keep" &&
      result.metric > 0 &&
      (this.state.bestMetric === null ||
        isBetter(result.metric, this.state.bestMetric, this.state.bestDirection))
    ) {
      this.state.bestMetric = result.metric;
    }

    // Set baseline from first result in segment if not yet set
    if (this.state.bestMetric === null && result.metric > 0) {
      this.state.bestMetric = result.metric;
    }

    // Persist
    const segResults = this.state.results.filter(
      (r) => r.segment === this.state.currentSegment,
    );
    const run = segResults.length;
    const line: JsonlResultLine = {
      run,
      commit: result.commit,
      metric: result.metric,
      metrics: result.metrics,
      status: result.status,
      description: result.description,
      timestamp: result.timestamp,
      segment: result.segment,
      confidence: result.confidence,
    };
    await this.appendJsonl(JSON.stringify(line));

    return this.formatLogResponse(result, run);
  }

  /** Return a copy of the current experiment state. */
  getState(): ExperimentState {
    return { ...this.state, results: [...this.state.results] };
  }

  /** Return a formatted human-readable summary of the session. */
  getSummary(): string {
    const s = this.state;
    const seg = s.results.filter((r) => r.segment === s.currentSegment);
    const kept = seg.filter((r) => r.status === "keep");
    const discarded = seg.filter((r) => r.status === "discard");
    const crashed = seg.filter((r) => r.status === "crash");

    const conf = computeConfidence(
      s.results,
      s.currentSegment,
      s.bestDirection,
    );
    const confStr = conf !== null ? `${conf.toFixed(1)}×` : "n/a";
    const confEmoji =
      conf === null ? "⚪" : conf >= 2 ? "🟢" : conf >= 1 ? "🟡" : "🔴";

    const lines = [
      `🔬 **${s.name ?? "Experiment"}** — segment ${s.currentSegment}`,
      `   Runs: ${seg.length} total, ${kept.length} kept, ${discarded.length} discarded, ${crashed.length} crashed`,
      `   Metric: ${s.metricName}${s.metricUnit ? ` (${s.metricUnit})` : ""} — ${s.bestDirection} is better`,
    ];

    if (s.bestMetric !== null) {
      lines.push(
        `   Best: ${s.bestMetric}${s.metricUnit ? ` ${s.metricUnit}` : ""}`,
      );
    }

    lines.push(`   Confidence: ${confEmoji} ${confStr}`);

    // Baseline delta
    if (kept.length > 0 && seg.length > 0 && seg[0].metric > 0) {
      const baseline = seg[0].metric;
      const best = s.bestMetric ?? baseline;
      const deltaPct = (((best - baseline) / baseline) * 100).toFixed(1);
      const sign = Number(deltaPct) > 0 ? "+" : "";
      lines.push(`   Delta from baseline: ${sign}${deltaPct}%`);
    }

    return lines.join("\n");
  }

  /** Reload state from the JSONL file on disk. */
  async loadFromDisk(): Promise<void> {
    const filePath = path.join(this.workDir, JSONL_FILENAME);
    try {
      await access(filePath);
    } catch {
      return; // File doesn't exist yet — start fresh
    }

    const content = await readFile(filePath, "utf-8");
    const state = this.emptyState();

    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;

        if (obj["type"] === "config") {
          // Config line → new segment
          if (state.results.length > 0) {
            state.currentSegment += 1;
          }
          state.name = (obj["name"] as string) ?? state.name;
          state.metricName = (obj["metricName"] as string) ?? state.metricName;
          state.metricUnit = (obj["metricUnit"] as string) ?? state.metricUnit;
          state.bestDirection =
            (obj["bestDirection"] as MetricDirection) ?? state.bestDirection;
          state.bestMetric = null;
        } else if (typeof obj["run"] === "number") {
          // Result line
          const r: ExperimentResult = {
            commit: (obj["commit"] as string) ?? "none",
            metric: (obj["metric"] as number) ?? 0,
            metrics: (obj["metrics"] as Record<string, number>) ?? {},
            status: (obj["status"] as ExperimentStatus) ?? "crash",
            description: (obj["description"] as string) ?? "",
            timestamp: (obj["timestamp"] as number) ?? 0,
            segment: (obj["segment"] as number) ?? state.currentSegment,
            confidence: (obj["confidence"] as number) ?? null,
          };
          state.results.push(r);

          if (
            r.segment === state.currentSegment &&
            r.status === "keep" &&
            r.metric > 0 &&
            (state.bestMetric === null ||
              isBetter(r.metric, state.bestMetric, state.bestDirection))
          ) {
            state.bestMetric = r.metric;
          }
          if (state.bestMetric === null && r.metric > 0) {
            state.bestMetric = r.metric;
          }
        }
      } catch {
        // Skip malformed lines
      }
    }

    this.state = state;
  }

  // -- Private helpers ------------------------------------------------------

  private emptyState(): ExperimentState {
    return {
      results: [],
      bestMetric: null,
      bestDirection: "lower",
      metricName: "",
      metricUnit: "",
      name: null,
      currentSegment: 0,
    };
  }

  private async appendJsonl(line: string): Promise<void> {
    const filePath = path.join(this.workDir, JSONL_FILENAME);
    await appendFile(filePath, line + "\n", "utf-8");
  }

  private formatLogResponse(result: ExperimentResult, run: number): string {
    const statusEmoji: Record<ExperimentStatus, string> = {
      keep: "✅",
      discard: "↩️",
      crash: "💥",
      checks_failed: "🚫",
    };

    const emoji = statusEmoji[result.status];
    const seg = this.state.results.filter(
      (r) => r.segment === this.state.currentSegment,
    );
    const baseline = seg.length > 0 && seg[0].metric > 0 ? seg[0].metric : null;

    const lines = [
      `${emoji} Run #${run} — **${result.status}**`,
      `   ${result.description}`,
      `   Metric: ${this.state.metricName} = ${result.metric}${this.state.metricUnit ? ` ${this.state.metricUnit}` : ""}`,
    ];

    if (baseline !== null && result.metric > 0) {
      const deltaPct = (
        ((result.metric - baseline) / baseline) *
        100
      ).toFixed(1);
      const sign = Number(deltaPct) > 0 ? "+" : "";
      lines.push(`   Delta from baseline: ${sign}${deltaPct}%`);
    }

    if (this.state.bestMetric !== null) {
      lines.push(
        `   Current best: ${this.state.bestMetric}${this.state.metricUnit ? ` ${this.state.metricUnit}` : ""}`,
      );
    }

    if (result.confidence !== null) {
      const confEmoji =
        result.confidence >= 2 ? "🟢" : result.confidence >= 1 ? "🟡" : "🔴";
      lines.push(
        `   Confidence: ${confEmoji} ${result.confidence.toFixed(1)}×`,
      );
    }

    return lines.join("\n");
  }
}
