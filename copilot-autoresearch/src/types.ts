/** Core type definitions for copilot-autoresearch. */

/** Direction in which a metric improves. */
export type MetricDirection = "lower" | "higher";

/** Outcome of a single experiment iteration. */
export type ExperimentStatus = "keep" | "discard" | "crash" | "checks_failed";

/** Actionable Side Information — free-form diagnostics per experiment run. */
export type ASI = Record<string, unknown>;

/** Secondary metric definition (name + display unit). */
export interface MetricDef {
  name: string;
  unit: string;
}

/** Configuration supplied to init_experiment. */
export interface ExperimentConfig {
  /** Human-readable session name, e.g. "Optimize render loop". */
  name: string;
  /** Primary metric identifier, e.g. "total_µs". */
  metricName: string;
  /** Display unit inferred from the metric name (µs, ms, s, kb, mb, or ""). */
  metricUnit: string;
  /** Whether a lower or higher metric value is better. */
  direction: MetricDirection;
}

/** A single experiment result persisted in the JSONL log. */
export interface ExperimentResult {
  /** Short git commit hash (7 chars) at the time of logging, or "none". */
  commit: string;
  /** Primary metric value (0 for crashes). */
  metric: number;
  /** All parsed metrics including secondary ones. */
  metrics: Record<string, number>;
  /** Outcome of this iteration. */
  status: ExperimentStatus;
  /** Free-form description of what was tried. */
  description: string;
  /** Unix-epoch milliseconds. */
  timestamp: number;
  /** Segment index (incremented on each init_experiment call). */
  segment: number;
  /** MAD-based confidence score, or null if insufficient data. */
  confidence: number | null;
  /** Actionable Side Information — structured diagnostics for this run. */
  asi?: ASI;
}

/** In-memory experiment session state, reconstructed from the JSONL log. */
export interface ExperimentState {
  /** All results across every segment. */
  results: ExperimentResult[];
  /** Best primary metric in the current segment (null until first result). */
  bestMetric: number | null;
  /** Whether lower or higher is better. */
  bestDirection: MetricDirection;
  /** Primary metric name. */
  metricName: string;
  /** Display unit for the primary metric. */
  metricUnit: string;
  /** Definitions for secondary metrics (order preserved). */
  secondaryMetrics: MetricDef[];
  /** Session name. */
  name: string | null;
  /** Current segment index (0-based). */
  currentSegment: number;
  /** Maximum experiments before auto-stopping. null = unlimited. */
  maxExperiments: number | null;
  /** Current session confidence score. null if insufficient data. */
  confidence: number | null;
}

/** Details returned after spawning a benchmark process. */
export interface RunDetails {
  /** The command that was executed. */
  command: string;
  /** Process exit code, or null if killed / timed out. */
  exitCode: number | null;
  /** Wall-clock duration in seconds. */
  durationSeconds: number;
  /** True when exit code is 0 and no timeout. */
  passed: boolean;
  /** True when the process crashed or timed out. */
  crashed: boolean;
  /** True when the process exceeded the timeout. */
  timedOut: boolean;
  /** Last lines of combined stdout+stderr (truncated). */
  tailOutput: string;
  /** null = checks not run, true/false = ran and result. */
  checksPass: boolean | null;
  /** True when the checks process exceeded its timeout. */
  checksTimedOut: boolean;
  /** Last lines of checks stdout+stderr (truncated to 80 lines). */
  checksOutput: string;
  /** Wall-clock duration of the checks run in seconds. */
  checksDuration: number;
  /** Parsed METRIC lines as a key→value map, or null on crash. */
  parsedMetrics: Record<string, number> | null;
  /** Value of the primary metric, or null if not found. */
  parsedPrimary: number | null;
  /** Primary metric name (echoed back for convenience). */
  metricName: string;
  /** Primary metric unit. */
  metricUnit: string;
}

/** Shape of autoresearch.config.json. */
export interface AutoresearchConfig {
  /** Maximum iterations before auto-stopping. */
  maxIterations?: number;
  /** Override the working directory for all autoresearch file I/O. */
  workingDir?: string;
}
