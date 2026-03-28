import type { Request, Response } from "express";
import {
  verifyRequestByKeyId,
  createAckEvent,
  createTextEvent,
  createDoneEvent,
} from "@copilot-extensions/preview-sdk";

import { ExperimentManager } from "./experiment.js";
import { TOOL_DEFINITIONS, handleToolCall } from "./tools.js";

// ---------------------------------------------------------------------------
// Per-session state (keyed by GitHub user login extracted from the token)
// ---------------------------------------------------------------------------

const sessions = new Map<string, ExperimentManager>();

async function getManager(sessionId: string): Promise<ExperimentManager> {
  let mgr = sessions.get(sessionId);
  if (!mgr) {
    mgr = new ExperimentManager();
    // Reload any prior session state from autoresearch.jsonl on disk
    await mgr.loadFromDisk();
    sessions.set(sessionId, mgr);
  }
  return mgr;
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are **copilot-autoresearch**, an autonomous experiment loop assistant.

## Setup

Before running experiments:
1. Ask (or infer): Goal, Benchmark Command, Primary Metric (name + direction), Files in scope, Constraints.
2. Create a git branch: \`git checkout -b autoresearch/<goal>-<date>\`
3. Read the source files deeply. Understand the workload before changing anything.
4. Write \`autoresearch.md\` (session context, objective, metrics, files in scope, what's been tried) and \`autoresearch.sh\` (benchmark script that prints \`METRIC name=value\` lines). Commit both.
5. Call \`init_experiment\` → run baseline → call \`log_experiment\` → start looping.

### autoresearch.md
The heart of the session. A fresh agent with no context should be able to read this and run the loop effectively.
Update the "What's Been Tried" section as experiments accumulate so resuming agents don't repeat failed approaches.

### autoresearch.sh
Bash script (\`set -euo pipefail\`) that: pre-checks fast (syntax errors in <1s), runs the benchmark, outputs \`METRIC name=value\` lines.
For fast noisy benchmarks (<5s), run the workload multiple times and report the median for stable data.

### autoresearch.checks.sh (optional)
Correctness backpressure script. Create ONLY when tests/types/lint must pass.
When it exists, \`run_experiment\` runs it automatically after every passing benchmark.
If checks fail, \`run_experiment\` reports it — log as \`checks_failed\`. You CANNOT use \`keep\` when checks failed.
Its execution time does NOT affect the primary metric. Suppress verbose success output; only let errors through.

### autoresearch.config.json (optional)
\`{ "maxIterations": 50, "workingDir": "/path/to/project" }\`
\`maxIterations\` — auto-stop after N experiments per segment.
\`workingDir\` — override directory for all file I/O and command execution.

## Loop Rules

**LOOP FOREVER. NEVER STOP unless interrupted.**

1. Call \`init_experiment\` once at the start. Do NOT call it again unless the optimization target changes.
2. Call \`run_experiment\` to execute the benchmark (always use \`autoresearch.sh\` if it exists).
3. Analyze the output — parse METRIC lines exactly.
4. Call \`log_experiment\` to record the result:
   - \`status=keep\` when PRIMARY metric improves (auto-commits via git).
   - \`status=discard\` when worse or unchanged (auto-reverts code changes; autoresearch files preserved).
   - \`status=crash\` when the benchmark failed to run (auto-reverts).
   - \`status=checks_failed\` when benchmark passed but checks.sh failed (auto-reverts).
   - Always include \`asi\` with what you learned (hypothesis, rollback_reason on discard/crash, next_action_hint).
   - Include ALL previously tracked secondary metrics — missing metrics are rejected.
5. Repeat from step 2.

## Quality Gates

- **Primary metric is king.** Improved → keep. Worse/equal → discard. Secondary metrics rarely override this.
- **Never keep when checks failed.** The checks gate exists to prevent correctness regressions.
- **Do not cheat on benchmarks.** Never write code that detects benchmark mode and produces fake results.
- **Watch confidence score.** After 3+ runs, \`log_experiment\` reports confidence (best improvement / noise floor). ≥2.0× = likely real. <1.0× = within noise — consider re-running to confirm. Advisory only — never auto-discards.
- **Simpler is better.** Removing code for equal perf = keep. Ugly complexity for tiny gain = probably discard.

## Ideas Backlog

When you discover complex but promising optimizations you won't pursue now, **append them as bullets to \`autoresearch.ideas.md\`**.
On resume (context limit, crash), check \`autoresearch.ideas.md\` — prune stale/tried entries, experiment with the rest.

## Resuming

If \`autoresearch.jsonl\` exists (previous session on disk), state is automatically reloaded. Read \`autoresearch.md\` and \`git log\` for context, then continue looping immediately.

## Tools

- \`init_experiment\` — configure session (name, metric, direction). Call again to re-initialize when the optimization target changes.
- \`run_experiment\` — runs command, times it, captures output, parses METRIC lines, runs checks.sh automatically.
- \`log_experiment\` — records result, auto-commits (keep) or auto-reverts (discard/crash/checks_failed).`;

// ---------------------------------------------------------------------------
// Request verification
// ---------------------------------------------------------------------------

async function verifyRequest(
  rawBody: string,
  signature: string,
  keyId: string,
): Promise<boolean> {
  try {
    const { isValid } = await verifyRequestByKeyId(rawBody, signature, keyId, {
      token: process.env.GITHUB_TOKEN ?? "",
    });
    return isValid;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Agent handler
// ---------------------------------------------------------------------------

export async function agentHandler(
  req: Request,
  res: Response,
): Promise<void> {
  // ── SSE headers ──────────────────────────────────────────────────────
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // ── Signature verification (skip in dev if no token) ─────────────────
  const rawBody: string =
    typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  const signature = (req.headers["github-public-key-signature"] as string) ?? "";
  const keyId = (req.headers["github-public-key-identifier"] as string) ?? "";

  if (process.env.GITHUB_TOKEN) {
    const valid = await verifyRequest(rawBody, signature, keyId);
    if (!valid) {
      res.write(createTextEvent("⚠️ Request signature verification failed."));
      res.write(createDoneEvent());
      res.end();
      return;
    }
  }

  // ── Parse payload ────────────────────────────────────────────────────
  let payload: { messages?: Array<{ role: string; content: string }> };
  try {
    payload = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch {
    res.write(createTextEvent("❌ Could not parse request body."));
    res.write(createDoneEvent());
    res.end();
    return;
  }

  const messages = payload.messages ?? [];
  const lastUserMessage =
    [...messages].reverse().find((m) => m.role === "user")?.content ?? "";

  // ── Send ack ─────────────────────────────────────────────────────────
  res.write(createAckEvent());

  // ── Session manager (loads from disk on first access) ────────────────
  const sessionId = keyId || "default";
  const manager = await getManager(sessionId);

  // ── Check for tool-like intent in the user message ───────────────────
  // In a full implementation the LLM would emit function_call / tool_use
  // messages; here we provide a lightweight keyword-based dispatch so the
  // extension works end-to-end even without an outer LLM orchestrator.

  const toolResult = await tryDirectToolDispatch(lastUserMessage, manager);

  if (toolResult !== null) {
    res.write(createTextEvent(toolResult));
    res.write(createDoneEvent());
    res.end();
    return;
  }

  // ── Build the response ───────────────────────────────────────────────
  const state = manager.getState();
  const hasExperiment = state.name !== null;

  let response: string;

  if (!hasExperiment && lastUserMessage) {
    response = [
      "👋 Welcome to **copilot-autoresearch**!\n",
      "I help you run autonomous optimization loops. To get started:\n",
      "1. Tell me what you want to optimize and how you measure it.",
      "2. I'll call `init_experiment` to set up the session.",
      "3. Create `autoresearch.sh` — a benchmark script that prints `METRIC name=value` lines.",
      "   Optionally create `autoresearch.checks.sh` for correctness backpressure (tests/types/lint).",
      "4. I'll loop: run benchmark → analyze → keep/discard → repeat. **NEVER stopping.**\n",
      "**What would you like to optimize?**",
    ].join("\n");
  } else if (hasExperiment) {
    const summary = manager.getSummary();
    response = [
      summary,
      "",
      `Your message: *${lastUserMessage}*`,
      "",
      "I can run the next experiment iteration. What change would you like to try?",
    ].join("\n");
  } else {
    response =
      "👋 I'm **copilot-autoresearch** — an autonomous experiment loop agent. " +
      "Describe what you'd like to optimize and I'll help you set up a benchmark loop.";
  }

  res.write(createTextEvent(response));
  res.write(createDoneEvent());
  res.end();
}

// ---------------------------------------------------------------------------
// Lightweight direct-dispatch for tool calls
// ---------------------------------------------------------------------------

interface ParsedDirective {
  tool: string;
  params: Record<string, unknown>;
}

function parseDirective(message: string): ParsedDirective | null {
  // Detect JSON-style tool invocations like:
  //   /init_experiment {"name":"x","metric_name":"y","direction":"lower"}
  //   /run_experiment {"command":"bash bench.sh"}
  //   /log_experiment {"metric":42,"status":"keep","description":"test"}
  const match = message.match(
    /^\/(init_experiment|run_experiment|log_experiment)\s+(\{[\s\S]*\})\s*$/,
  );
  if (!match) return null;

  try {
    const params = JSON.parse(match[2]) as Record<string, unknown>;
    return { tool: match[1], params };
  } catch {
    return null;
  }
}

async function tryDirectToolDispatch(
  message: string,
  manager: ExperimentManager,
): Promise<string | null> {
  const directive = parseDirective(message.trim());
  if (!directive) return null;
  return handleToolCall(directive.tool, directive.params, manager);
}

// Re-export for use in index.ts
export { SYSTEM_PROMPT, TOOL_DEFINITIONS };
