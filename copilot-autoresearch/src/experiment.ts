import { spawn, execFile } from "node:child_process";
import { readFile, appendFile, access, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type {
  AutoresearchConfig,
  ExperimentConfig,
  ExperimentResult,
  ExperimentState,
  ExperimentStatus,
  MetricDef,
  MetricDirection,
  RunDetails,
  ASI,
} from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const JSONL_FILENAME = "autoresearch.jsonl";
const CONFIG_FILENAME = "autoresearch.config.json";
const CHECKS_FILENAME = "autoresearch.checks.sh";
const AUTORESEARCH_SH = "autoresearch.sh";
const DEFAULT_TIMEOUT_S = 600;
const DEFAULT_CHECKS_TIMEOUT_S = 300;
const TAIL_MAX_LINES = 50;
const TAIL_MAX_BYTES = 4 * 1024;
const CHECKS_TAIL_LINES = 80;

/** Autoresearch session files that must never be reverted. */
const PROTECTED_FILES = [
  "autoresearch.jsonl",
  "autoresearch.md",
  "autoresearch.ideas.md",
  "autoresearch.sh",
  "autoresearch.checks.sh",
];

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

function tailOutput(raw: string, maxLines = TAIL_MAX_LINES, maxBytes = TAIL_MAX_BYTES): string {
  const lines = raw.split("\n");
  let tail = lines.slice(-maxLines).join("\n");
  if (tail.length > maxBytes) {
    tail = tail.slice(-maxBytes);
  }
  return tail;
}

// ---------------------------------------------------------------------------
// Helpers – config
// ---------------------------------------------------------------------------

/** Read autoresearch.config.json from the given directory. */
function readConfig(cwd: string): AutoresearchConfig {
  try {
    const configPath = path.join(cwd, CONFIG_FILENAME);
    if (!existsSync(configPath)) return {};
    return JSON.parse(readFileSync(configPath, "utf-8")) as AutoresearchConfig;
  } catch {
    return {};
  }
}

/** Resolve the effective working directory from config. */
function resolveWorkDir(ctxCwd: string): string {
  const config = readConfig(ctxCwd);
  if (!config.workingDir) return ctxCwd;
  return path.isAbsolute(config.workingDir)
    ? config.workingDir
    : path.resolve(ctxCwd, config.workingDir);
}

/** Validate that the resolved working directory exists. Returns error string or null. */
async function validateWorkDir(ctxCwd: string): Promise<string | null> {
  const workDir = resolveWorkDir(ctxCwd);
  if (workDir === ctxCwd) return null;
  try {
    const s = await stat(workDir);
    if (!s.isDirectory()) {
      return `workingDir "${workDir}" (from autoresearch.config.json) is not a directory.`;
    }
    return null;
  } catch {
    return `workingDir "${workDir}" (from autoresearch.config.json) does not exist.`;
  }
}

/** Read maxIterations from autoresearch.config.json. */
function readMaxExperiments(cwd: string): number | null {
  const config = readConfig(cwd);
  return typeof config.maxIterations === "number" && config.maxIterations > 0
    ? Math.floor(config.maxIterations)
    : null;
}

// ---------------------------------------------------------------------------
// Helpers – autoresearch.sh guard
// ---------------------------------------------------------------------------

/**
 * Check if a command's primary purpose is running autoresearch.sh.
 * Rejects chaining tricks like "evil.py; autoresearch.sh".
 */
function isAutoresearchShCommand(command: string): boolean {
  let cmd = command.trim();
  // Strip leading env variable assignments
  cmd = cmd.replace(/^(?:\w+=\S*\s+)+/, "");
  // Strip known harmless command wrappers repeatedly
  let prev: string;
  do {
    prev = cmd;
    cmd = cmd.replace(/^(?:env|time|nice|nohup)(?:\s+-\S+(?:\s+\d+)?)*\s+/, "");
  } while (cmd !== prev);
  // Pattern: optional "bash|sh|source [-flags]" + optional path prefix + "autoresearch.sh"
  // This accepts: autoresearch.sh, ./autoresearch.sh, bash autoresearch.sh, bash -euo autoresearch.sh
  // Rejects chaining tricks (e.g. "evil.sh; autoresearch.sh") by requiring autoresearch.sh first.
  return /^(?:(?:bash|sh|source)\s+(?:-\w+\s+)*)?(?:\.\/|\/[\w/.-]*\/)?autoresearch\.sh(?:\s|$)/.test(cmd);
}

// ---------------------------------------------------------------------------
// Helpers – git operations
// ---------------------------------------------------------------------------

function execGit(args: string[], cwd: string, timeoutMs = 10_000): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: timeoutMs }, (err, stdoutBuf, stderrBuf) => {
      const output = (stdoutBuf + stderrBuf).trim();
      resolve({ code: err ? (err.code as number ?? 1) : 0, output });
    });
  });
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
  asi?: ASI;
}

// ---------------------------------------------------------------------------
// ExperimentManager
// ---------------------------------------------------------------------------

export class ExperimentManager {
  private state: ExperimentState;
  private workDir: string;
  /** The directory from which to read autoresearch.config.json. */
  private ctxCwd: string;
  /** Result of last run_experiment's checks.sh execution. */
  private lastRunChecks: { pass: boolean; output: string; duration: number } | null = null;

  constructor(workDir?: string) {
    this.ctxCwd = workDir ?? process.cwd();
    this.workDir = resolveWorkDir(this.ctxCwd);
    this.state = this.emptyState();
  }

  // -- Public API -----------------------------------------------------------

  /** Initialize (or reinitialize) an experiment session. */
  async initExperiment(config: ExperimentConfig): Promise<string> {
    // Validate working directory
    const workDirError = await validateWorkDir(this.ctxCwd);
    if (workDirError) return `❌ ${workDirError}`;

    // Re-resolve workDir in case config changed
    this.workDir = resolveWorkDir(this.ctxCwd);

    const isReinit = this.state.results.length > 0;

    if (isReinit) {
      this.state.currentSegment += 1;
    }

    this.state.name = config.name;
    this.state.metricName = config.metricName;
    this.state.metricUnit = config.metricUnit || inferUnit(config.metricName);
    this.state.bestDirection = config.direction;
    this.state.bestMetric = null;
    this.state.secondaryMetrics = [];
    this.state.confidence = null;
    this.state.maxExperiments = readMaxExperiments(this.ctxCwd);
    this.lastRunChecks = null;

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
    const limitNote = this.state.maxExperiments !== null
      ? `\n   Max iterations: ${this.state.maxExperiments} (from ${CONFIG_FILENAME})`
      : "";
    const workDirNote = this.workDir !== this.ctxCwd
      ? `\n   Working dir: ${this.workDir}`
      : "";

    return [
      `✅ Experiment initialized${isReinit ? " (new segment)" : ""}`,
      `   Name:      ${config.name}`,
      `   Metric:    ${config.metricName}${this.state.metricUnit ? ` (${this.state.metricUnit})` : ""}`,
      `   Direction: ${config.direction} is better`,
      `   WorkDir:   ${dir}`,
      `   Segment:   ${this.state.currentSegment}`,
    ].join("\n") + limitNote + workDirNote;
  }

  /** Spawn a benchmark command, capture output, parse METRIC lines, run checks.sh. */
  async runExperiment(
    command: string,
    timeoutSeconds?: number,
    checksTimeoutSeconds?: number,
  ): Promise<RunDetails> {
    const timeout = timeoutSeconds ?? DEFAULT_TIMEOUT_S;
    const checksTimeout = checksTimeoutSeconds ?? DEFAULT_CHECKS_TIMEOUT_S;

    // Check max experiments limit
    if (this.state.maxExperiments !== null) {
      const segCount = this.state.results.filter(
        (r) => r.segment === this.state.currentSegment,
      ).length;
      if (segCount >= this.state.maxExperiments) {
        return this.maxLimitResult(command);
      }
    }

    // Guard: if autoresearch.sh exists, require it to be used
    const autoresearchShPath = path.join(this.workDir, AUTORESEARCH_SH);
    if (existsSync(autoresearchShPath) && !isAutoresearchShCommand(command)) {
      return {
        command,
        exitCode: null,
        durationSeconds: 0,
        passed: false,
        crashed: true,
        timedOut: false,
        tailOutput: [
          `❌ ${AUTORESEARCH_SH} exists — you must run it instead of a custom command.`,
          `Found: ${autoresearchShPath}`,
          `Your command: ${command}`,
          `Use: run_experiment with command "bash autoresearch.sh" or "./autoresearch.sh"`,
        ].join("\n"),
        checksPass: null,
        checksTimedOut: false,
        checksOutput: "",
        checksDuration: 0,
        parsedMetrics: null,
        parsedPrimary: null,
        metricName: this.state.metricName,
        metricUnit: this.state.metricUnit,
      };
    }

    this.lastRunChecks = null;

    const benchResult = await this.spawnCommand(command, this.workDir, timeout);

    let parsedMetrics: Record<string, number> | null = null;
    let parsedPrimary: number | null = null;

    if (benchResult.passed) {
      const metricsMap = parseMetricLines(benchResult.output);
      if (metricsMap.size > 0) {
        parsedMetrics = Object.fromEntries(metricsMap);
        parsedPrimary = metricsMap.get(this.state.metricName) ?? null;
      }
    }

    // Run checks.sh if benchmark passed and the file exists
    const checksPath = path.join(this.workDir, CHECKS_FILENAME);
    let checksPass: boolean | null = null;
    let checksTimedOut = false;
    let checksOutput = "";
    let checksDuration = 0;

    if (benchResult.passed && existsSync(checksPath)) {
      const checksResult = await this.spawnCommand(
        `bash "${checksPath}"`,
        this.workDir,
        checksTimeout,
      );
      checksPass = checksResult.passed;
      checksTimedOut = checksResult.timedOut;
      checksOutput = tailOutput(checksResult.output, CHECKS_TAIL_LINES, 8 * 1024);
      checksDuration = checksResult.durationSeconds;
      this.lastRunChecks = { pass: checksPass, output: checksOutput, duration: checksDuration };
    }

    return {
      command,
      exitCode: benchResult.exitCode,
      durationSeconds: benchResult.durationSeconds,
      passed: benchResult.passed,
      crashed: !benchResult.passed,
      timedOut: benchResult.timedOut,
      tailOutput: tailOutput(benchResult.output),
      checksPass,
      checksTimedOut,
      checksOutput,
      checksDuration,
      parsedMetrics,
      parsedPrimary,
      metricName: this.state.metricName,
      metricUnit: this.state.metricUnit,
    };
  }

  /** Record an experiment result (keep / discard / crash / checks_failed). */
  async logExperiment(params: {
    commit?: string;
    metric: number;
    status: ExperimentStatus;
    description: string;
    metrics?: Record<string, number>;
    asi?: ASI;
    force?: boolean;
  }): Promise<string> {
    // Gate: prevent "keep" when last run's checks failed
    if (params.status === "keep" && this.lastRunChecks && !this.lastRunChecks.pass) {
      return [
        `❌ Cannot keep — ${CHECKS_FILENAME} failed.`,
        "",
        this.lastRunChecks.output.slice(-500),
        "",
        `Log as 'checks_failed' instead. The benchmark metric is valid but correctness checks did not pass.`,
      ].join("\n");
    }

    const secondaryMetrics = params.metrics ?? {};

    // Validate secondary metrics consistency (after first experiment establishes them)
    if (this.state.secondaryMetrics.length > 0) {
      const knownNames = new Set(this.state.secondaryMetrics.map((m) => m.name));
      const providedNames = new Set(Object.keys(secondaryMetrics));

      // Check for missing metrics
      const missing = [...knownNames].filter((n) => !providedNames.has(n));
      if (missing.length > 0) {
        return [
          `❌ Missing secondary metrics: ${missing.join(", ")}`,
          `You must provide all previously tracked metrics.`,
          `Expected: ${[...knownNames].join(", ")}`,
          `Got: ${[...providedNames].join(", ") || "(none)"}`,
          `Fix: include ${missing.map((m) => `"${m}": <value>`).join(", ")} in the metrics parameter.`,
        ].join("\n");
      }

      // Check for new metrics not yet tracked
      const newMetrics = [...providedNames].filter((n) => !knownNames.has(n));
      if (newMetrics.length > 0 && !params.force) {
        return [
          `❌ New secondary metric${newMetrics.length > 1 ? "s" : ""} not previously tracked: ${newMetrics.join(", ")}`,
          `Existing metrics: ${[...knownNames].join(", ")}`,
          `If this metric has proven valuable, call log_experiment again with force=true to add it.`,
          `Otherwise, remove it from the metrics parameter.`,
        ].join("\n");
      }
    }

    const confidence = computeConfidence(
      this.state.results,
      this.state.currentSegment,
      this.state.bestDirection,
    );

    const result: ExperimentResult = {
      commit: params.commit?.slice(0, 7) ?? "none",
      metric: params.metric,
      metrics: secondaryMetrics,
      status: params.status,
      description: params.description,
      timestamp: Date.now(),
      segment: this.state.currentSegment,
      confidence,
      asi: params.asi && Object.keys(params.asi).length > 0 ? params.asi : undefined,
    };

    this.state.results.push(result);

    // Register any new secondary metric names
    for (const name of Object.keys(secondaryMetrics)) {
      if (!this.state.secondaryMetrics.find((m) => m.name === name)) {
        this.state.secondaryMetrics.push({ name, unit: inferUnit(name) });
      }
    }

    // Baseline = first result in segment
    this.state.bestMetric = this.findBaselineMetric();

    // Update confidence on state
    this.state.confidence = confidence;

    const segResults = this.state.results.filter(
      (r) => r.segment === this.state.currentSegment,
    );
    const run = segResults.length;

    // Persist
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
      ...(result.asi ? { asi: result.asi } : {}),
    };
    await this.appendJsonl(JSON.stringify(line));

    let responseText = this.formatLogResponse(result, run);

    // Auto-commit on keep; auto-revert on discard/crash/checks_failed
    if (params.status === "keep") {
      responseText += await this.gitCommit(result);
    } else {
      responseText += await this.gitRevert();
    }

    // Clear last checks state (consumed by this log)
    this.lastRunChecks = null;

    return responseText;
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
    const checksFailed = seg.filter((r) => r.status === "checks_failed");

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
      `   Runs: ${seg.length} total, ${kept.length} kept, ${discarded.length} discarded, ${crashed.length} crashed, ${checksFailed.length} checks_failed`,
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

    if (s.maxExperiments !== null) {
      const segCount = seg.length;
      lines.push(`   Iterations: ${segCount} / ${s.maxExperiments} max`);
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
            state.secondaryMetrics = [];
          }
          state.name = (obj["name"] as string) ?? state.name;
          state.metricName = (obj["metricName"] as string) ?? state.metricName;
          state.metricUnit = (obj["metricUnit"] as string) ?? state.metricUnit;
          state.bestDirection =
            (obj["bestDirection"] as MetricDirection) ?? state.bestDirection;
          state.bestMetric = null;
          state.confidence = null;
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
            confidence: (obj["confidence"] as number | null) ?? null,
            asi: (obj["asi"] as ASI | undefined) ?? undefined,
          };
          state.results.push(r);

          // Register secondary metrics
          for (const name of Object.keys(r.metrics)) {
            if (!state.secondaryMetrics.find((m) => m.name === name)) {
              state.secondaryMetrics.push({ name, unit: inferUnit(name) });
            }
          }

          if (r.segment === state.currentSegment && r.metric > 0) {
            state.bestMetric = state.bestMetric ?? r.metric;
          }
        }
      } catch {
        // Skip malformed lines
      }
    }

    // Re-compute baseline (first result in current segment)
    const segResults = state.results.filter(
      (r) => r.segment === state.currentSegment,
    );
    if (segResults.length > 0 && segResults[0].metric > 0) {
      state.bestMetric = segResults[0].metric;
    }
    state.confidence = computeConfidence(
      state.results,
      state.currentSegment,
      state.bestDirection,
    );

    // Read max experiments from config
    state.maxExperiments = readMaxExperiments(this.ctxCwd);

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
      secondaryMetrics: [],
      name: null,
      currentSegment: 0,
      maxExperiments: null,
      confidence: null,
    };
  }

  private findBaselineMetric(): number | null {
    const seg = this.state.results.filter(
      (r) => r.segment === this.state.currentSegment,
    );
    return seg.length > 0 && seg[0].metric > 0 ? seg[0].metric : null;
  }

  private async appendJsonl(line: string): Promise<void> {
    const filePath = path.join(this.workDir, JSONL_FILENAME);
    await appendFile(filePath, line + "\n", "utf-8");
  }

  /** Spawn a command, capture output, return basic result. */
  private spawnCommand(
    command: string,
    cwd: string,
    timeoutSeconds: number,
  ): Promise<{
    exitCode: number | null;
    durationSeconds: number;
    passed: boolean;
    timedOut: boolean;
    output: string;
  }> {
    return new Promise((resolve) => {
      let output = "";
      let timedOut = false;
      const start = Date.now();

      const child = spawn("bash", ["-c", command], {
        cwd,
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
      }, timeoutSeconds * 1000);

      child.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        const durationSeconds =
          Math.round(((Date.now() - start) / 1000) * 10) / 10;
        const exitCode = timedOut ? null : code;
        const passed = !timedOut && code === 0;
        resolve({ exitCode, durationSeconds, passed, timedOut, output });
      });

      child.on("error", () => {
        clearTimeout(timer);
        const durationSeconds =
          Math.round(((Date.now() - start) / 1000) * 10) / 10;
        resolve({
          exitCode: null,
          durationSeconds,
          passed: false,
          timedOut: false,
          output,
        });
      });
    });
  }

  /** A synthetic RunDetails returned when the max iterations limit is reached. */
  private maxLimitResult(command: string): RunDetails {
    return {
      command,
      exitCode: null,
      durationSeconds: 0,
      passed: false,
      crashed: false,
      timedOut: false,
      tailOutput: `🛑 Maximum experiments reached (${this.state.maxExperiments}). Call init_experiment to start a new segment.`,
      checksPass: null,
      checksTimedOut: false,
      checksOutput: "",
      checksDuration: 0,
      parsedMetrics: null,
      parsedPrimary: null,
      metricName: this.state.metricName,
      metricUnit: this.state.metricUnit,
    };
  }

  /** Auto-commit all changes when status=keep. */
  private async gitCommit(result: ExperimentResult): Promise<string> {
    try {
      const addResult = await execGit(["add", "-A"], this.workDir);
      if (addResult.code !== 0) {
        return `\n⚠️ Git add failed: ${addResult.output.slice(0, 200)}`;
      }

      const diffResult = await execGit(
        ["diff", "--cached", "--quiet"],
        this.workDir,
      );
      if (diffResult.code === 0) {
        return `\n📝 Git: nothing to commit (working tree clean)`;
      }

      const trailerJson = JSON.stringify({
        status: result.status,
        [this.state.metricName || "metric"]: result.metric,
        ...result.metrics,
      });
      const commitMsg = `${result.description}\n\nResult: ${trailerJson}`;

      const commitResult = await execGit(
        ["commit", "-m", commitMsg],
        this.workDir,
      );
      if (commitResult.code !== 0) {
        return `\n⚠️ Git commit failed: ${commitResult.output.slice(0, 200)}`;
      }

      const firstLine = commitResult.output.split("\n")[0] ?? "";

      // Update commit hash on the result
      const shaResult = await execGit(
        ["rev-parse", "--short=7", "HEAD"],
        this.workDir,
        5_000,
      );
      const newSha = shaResult.output.trim();
      if (newSha.length >= 7) {
        result.commit = newSha;
      }

      return `\n📝 Git: committed — ${firstLine}`;
    } catch (e) {
      return `\n⚠️ Git commit error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  /** Auto-revert code changes on discard/crash/checks_failed, preserving session files. */
  private async gitRevert(): Promise<string> {
    try {
      // Safety check: verify workDir is inside a git repository before modifying the tree
      const checkResult = await execGit(["rev-parse", "--git-dir"], this.workDir, 5_000);
      if (checkResult.code !== 0) {
        return `\n⚠️ Git revert skipped: working directory is not a git repository`;
      }

      const stageCmd = PROTECTED_FILES.map(
        (f) => `git add "${path.join(this.workDir, f)}" 2>/dev/null || true`,
      ).join("; ");
      const revertCmd = `${stageCmd}; git checkout -- . 2>/dev/null; git clean -fd 2>/dev/null || true`;
      const result = await this.spawnCommand(revertCmd, this.workDir, 15);
      if (!result.passed && result.output.includes("fatal:")) {
        return `\n⚠️ Git revert warning: ${result.output.slice(0, 200)}`;
      }
      return `\n📝 Git: reverted changes — autoresearch files preserved`;
    } catch (e) {
      return `\n⚠️ Git revert error: ${e instanceof Error ? e.message : String(e)}`;
    }
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

    // Secondary metrics with deltas
    if (Object.keys(result.metrics).length > 0 && seg.length > 0) {
      const baselineSecondary = seg[0].metrics ?? {};
      const parts: string[] = [];
      for (const [name, value] of Object.entries(result.metrics)) {
        const def = this.state.secondaryMetrics.find((m) => m.name === name);
        const unit = def?.unit ?? "";
        let part = `${name}: ${value}${unit}`;
        const bv = baselineSecondary[name];
        if (bv !== undefined && seg.length > 1 && bv !== 0) {
          const d = value - bv;
          const p = ((d / bv) * 100).toFixed(1);
          const s = d > 0 ? "+" : "";
          part += ` (${s}${p}%)`;
        }
        parts.push(part);
      }
      lines.push(`   Secondary: ${parts.join("  ")}`);
    }

    if (result.confidence !== null) {
      const confEmoji =
        result.confidence >= 2 ? "🟢" : result.confidence >= 1 ? "🟡" : "🔴";
      if (result.confidence >= 2.0) {
        lines.push(
          `   Confidence: ${confEmoji} ${result.confidence.toFixed(1)}× — improvement is likely real`,
        );
      } else if (result.confidence >= 1.0) {
        lines.push(
          `   Confidence: ${confEmoji} ${result.confidence.toFixed(1)}× — above noise but marginal`,
        );
      } else {
        lines.push(
          `   Confidence: ${confEmoji} ${result.confidence.toFixed(1)}× — within noise; consider re-running to confirm`,
        );
      }
    }

    if (result.asi) {
      const asiParts: string[] = [];
      for (const [k, v] of Object.entries(result.asi)) {
        const s = typeof v === "string" ? v : JSON.stringify(v);
        asiParts.push(`${k}: ${s.length > 80 ? s.slice(0, 77) + "…" : s}`);
      }
      if (asiParts.length > 0) {
        lines.push(`   📋 ASI: ${asiParts.join(" | ")}`);
      }
    }

    const segCount = seg.length;
    const maxNote = this.state.maxExperiments !== null
      ? ` / ${this.state.maxExperiments} max`
      : "";
    lines.push(`   (${segCount}${maxNote} experiments in segment ${this.state.currentSegment})`);

    return lines.join("\n");
  }
}
