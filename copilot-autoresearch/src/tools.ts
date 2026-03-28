import type { ExperimentManager } from "./experiment.js";
import type { ASI, ExperimentStatus, MetricDirection } from "./types.js";

// ---------------------------------------------------------------------------
// Tool definitions (JSON Schema for Copilot function calling)
// ---------------------------------------------------------------------------

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required: string[];
    };
  };
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "init_experiment",
      description:
        "Initialize an experiment session. Call once before running experiments. " +
        "Calling again starts a new segment (allows switching optimization targets). " +
        "If autoresearch.jsonl already exists with a config, do NOT call init_experiment again unless the optimization target changes.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              'Human-readable session name, e.g. "Optimize render loop".',
          },
          metric_name: {
            type: "string",
            description:
              'Primary metric identifier printed by the benchmark, e.g. "total_µs".',
          },
          direction: {
            type: "string",
            enum: ["lower", "higher"],
            description: "Whether a lower or higher metric value is better.",
          },
        },
        required: ["name", "metric_name", "direction"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_experiment",
      description:
        "Execute a benchmark command, capture stdout/stderr, and parse METRIC lines. " +
        "The command should print lines like `METRIC total_µs=15200` to report measurements. " +
        "If autoresearch.sh exists in the working directory, only that script may be run. " +
        "If autoresearch.checks.sh exists, it runs automatically after a passing benchmark; " +
        "if it fails the result is reported as checks_failed.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Shell command to run (executed via bash -c).",
          },
          timeout_seconds: {
            type: "number",
            description:
              "Maximum seconds before the process is killed. Defaults to 600.",
          },
          checks_timeout_seconds: {
            type: "number",
            description:
              "Maximum seconds before autoresearch.checks.sh is killed. Defaults to 300.",
          },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "log_experiment",
      description:
        "Record the result of the last experiment run. " +
        "Use status=keep to commit the changes (auto-commits via git), " +
        "status=discard to revert (auto-reverts code changes, preserving autoresearch files), " +
        "status=crash if the run failed, or status=checks_failed if checks did not pass. " +
        "You cannot use status=keep when the last run's checks failed. " +
        "Always include all previously tracked secondary metrics.",
      parameters: {
        type: "object",
        properties: {
          metric: {
            type: "number",
            description: "Primary metric value (use 0 for crashes).",
          },
          status: {
            type: "string",
            enum: ["keep", "discard", "crash", "checks_failed"],
            description: "Outcome of this iteration.",
          },
          description: {
            type: "string",
            description: "Brief description of what was tried.",
          },
          commit: {
            type: "string",
            description: "Short git commit hash (optional; auto-populated on keep).",
          },
          metrics: {
            type: "object",
            description:
              "Additional parsed metrics as key-value pairs (optional). Must include all previously tracked secondary metrics.",
            additionalProperties: { type: "number" },
          },
          asi: {
            type: "object",
            description:
              "Actionable Side Information — free-form key/value diagnostics for this run. " +
              "Record what you learned, not what you did. Heavy annotation on discard/crash is strongly encouraged — " +
              "the ASI is the only structured memory that survives reverts.",
            additionalProperties: true,
          },
          force: {
            type: "boolean",
            description:
              "Set to true to allow adding a new secondary metric not previously tracked. " +
              "Only use when the metric has proven valuable to monitor.",
          },
        },
        required: ["metric", "status", "description"],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

/** Dispatch a tool call to the appropriate ExperimentManager method. */
export async function handleToolCall(
  toolName: string,
  params: Record<string, unknown>,
  manager: ExperimentManager,
): Promise<string> {
  switch (toolName) {
    case "init_experiment": {
      const name = String(params["name"] ?? "Experiment");
      const metricName = String(params["metric_name"] ?? "metric");
      const direction = (params["direction"] as MetricDirection) ?? "lower";
      return manager.initExperiment({
        name,
        metricName,
        metricUnit: "",
        direction,
      });
    }

    case "run_experiment": {
      const command = String(params["command"] ?? "echo no command");
      const timeout =
        typeof params["timeout_seconds"] === "number"
          ? params["timeout_seconds"]
          : undefined;
      const checksTimeout =
        typeof params["checks_timeout_seconds"] === "number"
          ? params["checks_timeout_seconds"]
          : undefined;
      const details = await manager.runExperiment(command, timeout, checksTimeout);

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
        lines.push(`🚫 Checks FAILED in ${details.checksDuration}s — log as checks_failed`);
        if (details.checksOutput) {
          lines.push("", "--- checks output tail ---", details.checksOutput);
        }
      }

      if (details.tailOutput) {
        lines.push("", "--- output tail ---", details.tailOutput);
      }

      return lines.join("\n");
    }

    case "log_experiment": {
      const metric =
        typeof params["metric"] === "number" ? params["metric"] : 0;
      const status = (params["status"] as ExperimentStatus) ?? "crash";
      const description = String(params["description"] ?? "");
      const commit =
        typeof params["commit"] === "string" ? params["commit"] : undefined;
      const metrics =
        typeof params["metrics"] === "object" && params["metrics"] !== null
          ? (params["metrics"] as Record<string, number>)
          : undefined;
      const asi =
        typeof params["asi"] === "object" && params["asi"] !== null
          ? (params["asi"] as ASI)
          : undefined;
      const force =
        typeof params["force"] === "boolean" ? params["force"] : false;

      return manager.logExperiment({
        metric,
        status,
        description,
        commit,
        metrics,
        asi,
        force,
      });
    }

    default:
      return `Unknown tool: ${toolName}`;
  }
}
