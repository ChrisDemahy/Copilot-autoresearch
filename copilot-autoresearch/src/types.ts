/** Core type definitions for copilot-autoresearch. */

/** Direction in which a metric improves. */
export type MetricDirection = "lower" | "higher";

/** Outcome of a single experiment iteration. */
export type ExperimentStatus = "keep" | "discard" | "crash" | "checks_failed";

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
  /** Session name. */
  name: string | null;
  /** Current segment index (0-based). */
  currentSegment: number;
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
  /** Parsed METRIC lines as a key→value map, or null on crash. */
  parsedMetrics: Record<string, number> | null;
  /** Value of the primary metric, or null if not found. */
  parsedPrimary: number | null;
  /** Primary metric name (echoed back for convenience). */
  metricName: string;
  /** Primary metric unit. */
  metricUnit: string;
}

/** Represents a single tool invocation requested by the LLM. */
export interface ToolCall {
  /** Tool function name (init_experiment, run_experiment, log_experiment). */
  name: string;
  /** JSON-decoded parameters for the tool. */
  parameters: Record<string, unknown>;
}
