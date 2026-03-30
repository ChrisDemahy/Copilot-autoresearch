import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ExperimentManager } from "./experiment.js";
import type { ASI, ExperimentStatus } from "./types.js";

// ---------------------------------------------------------------------------
// Tool registration — wires up MCP tools to ExperimentManager methods
// ---------------------------------------------------------------------------

export function registerTools(
  server: McpServer,
  manager: ExperimentManager,
): void {
  // ── init_experiment ─────────────────────────────────────────────────────
  server.tool(
    "init_experiment",
    "Initialize an experiment session. Call once before running experiments. " +
      "Calling again starts a new segment (allows switching optimization targets). " +
      "If autoresearch.jsonl already exists with a config, do NOT call init_experiment again unless the optimization target changes.",
    {
      name: z
        .string()
        .describe('Human-readable session name, e.g. "Optimize render loop".'),
      metric_name: z
        .string()
        .describe(
          'Primary metric identifier printed by the benchmark, e.g. "total_µs".',
        ),
      direction: z
        .enum(["lower", "higher"])
        .describe("Whether a lower or higher metric value is better."),
    },
    async ({ name, metric_name, direction }) => {
      const result = await manager.initExperiment({
        name,
        metricName: metric_name,
        metricUnit: "",
        direction,
      });
      return { content: [{ type: "text" as const, text: result }] };
    },
  );

  // ── run_experiment ──────────────────────────────────────────────────────
  server.tool(
    "run_experiment",
    "Execute a benchmark command, capture stdout/stderr, and parse METRIC lines. " +
      "The command should print lines like `METRIC total_µs=15200` to report measurements. " +
      "If autoresearch.sh exists in the working directory, only that script may be run. " +
      "If autoresearch.checks.sh exists, it runs automatically after a passing benchmark; " +
      "if it fails the result is reported as checks_failed.",
    {
      command: z
        .string()
        .describe("Shell command to run (executed via bash -c)."),
      timeout_seconds: z
        .number()
        .optional()
        .describe(
          "Maximum seconds before the process is killed. Defaults to 600.",
        ),
      checks_timeout_seconds: z
        .number()
        .optional()
        .describe(
          "Maximum seconds before autoresearch.checks.sh is killed. Defaults to 300.",
        ),
    },
    async ({ command, timeout_seconds, checks_timeout_seconds }) => {
      const details = await manager.runExperiment(
        command,
        timeout_seconds,
        checks_timeout_seconds,
      );

      const statusEmoji = details.passed ? "✅ PASSED" : "💥 FAILED";
      const lines = [
        `${statusEmoji} in ${details.durationSeconds}s`,
        details.timedOut ? "⏱️ Timed out" : "",
        details.exitCode !== null ? `Exit code: ${details.exitCode}` : "",
      ].filter(Boolean);

      if (details.parsedMetrics) {
        const metricsStr = Object.entries(details.parsedMetrics)
          .map(([k, v]) => {
            const star = k === details.metricName ? "★ " : "";
            return `${star}${k}=${v}`;
          })
          .join("  ");
        lines.push(`📐 Parsed metrics: ${metricsStr}`);
      }

      if (details.parsedPrimary !== null) {
        lines.push(
          `📊 Primary metric (${details.metricName}): ${details.parsedPrimary}${details.metricUnit ? ` ${details.metricUnit}` : ""}`,
        );
      }

      // Checks result
      if (details.checksPass === true) {
        lines.push(`✓ Checks passed in ${details.checksDuration}s`);
      } else if (details.checksTimedOut) {
        lines.push(`⏰ Checks timed out after ${details.checksDuration}s`);
        if (details.checksOutput) {
          lines.push("", "--- checks output tail ---", details.checksOutput);
        }
      } else if (details.checksPass === false) {
        lines.push(
          `🚫 Checks FAILED in ${details.checksDuration}s — log as checks_failed`,
        );
        if (details.checksOutput) {
          lines.push("", "--- checks output tail ---", details.checksOutput);
        }
      }

      if (details.tailOutput) {
        lines.push("", "--- output tail ---", details.tailOutput);
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );

  // ── log_experiment ──────────────────────────────────────────────────────
  server.tool(
    "log_experiment",
    "Record the result of the last experiment run. " +
      "Use status=keep to commit the changes (auto-commits via git), " +
      "status=discard to revert (auto-reverts code changes, preserving autoresearch files), " +
      "status=crash if the run failed, or status=checks_failed if checks did not pass. " +
      "You cannot use status=keep when the last run's checks failed. " +
      "Always include all previously tracked secondary metrics.",
    {
      metric: z
        .number()
        .describe("Primary metric value (use 0 for crashes)."),
      status: z
        .enum(["keep", "discard", "crash", "checks_failed"])
        .describe("Outcome of this iteration."),
      description: z
        .string()
        .describe("Brief description of what was tried."),
      commit: z
        .string()
        .optional()
        .describe(
          "Short git commit hash (optional; auto-populated on keep).",
        ),
      metrics: z
        .record(z.string(), z.number())
        .optional()
        .describe(
          "Additional parsed metrics as key-value pairs (optional). Must include all previously tracked secondary metrics.",
        ),
      asi: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          "Actionable Side Information — free-form key/value diagnostics for this run. " +
            "Record what you learned, not what you did. Heavy annotation on discard/crash is strongly encouraged — " +
            "the ASI is the only structured memory that survives reverts.",
        ),
      force: z
        .boolean()
        .optional()
        .describe(
          "Set to true to allow adding a new secondary metric not previously tracked. " +
            "Only use when the metric has proven valuable to monitor.",
        ),
    },
    async ({ metric, status, description, commit, metrics, asi, force }) => {
      const result = await manager.logExperiment({
        metric,
        status: status as ExperimentStatus,
        description,
        commit,
        metrics,
        asi: asi as ASI | undefined,
        force: force ?? false,
      });
      return { content: [{ type: "text" as const, text: result }] };
    },
  );
}
