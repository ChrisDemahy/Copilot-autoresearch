import type { Request, Response } from "express";
import {
  verifyRequestByKeyId,
  createAckEvent,
  createTextEvent,
  createDoneEvent,
  createConfirmationEvent,
} from "@copilot-extensions/preview-sdk";

import { ExperimentManager } from "./experiment.js";
import { TOOL_DEFINITIONS, handleToolCall } from "./tools.js";

// ---------------------------------------------------------------------------
// Per-session state (keyed by GitHub user login extracted from the token)
// ---------------------------------------------------------------------------

const sessions = new Map<string, ExperimentManager>();

function getManager(sessionId: string): ExperimentManager {
  let mgr = sessions.get(sessionId);
  if (!mgr) {
    mgr = new ExperimentManager();
    sessions.set(sessionId, mgr);
  }
  return mgr;
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are **copilot-autoresearch**, an autonomous experiment loop assistant.

Your job is to help the user optimize code through a repeating cycle:
1. Understand the optimization goal.
2. Call \`init_experiment\` to configure the session (metric name, direction).
3. Help the user create or edit a benchmark script that prints \`METRIC name=value\` lines.
4. Call \`run_experiment\` to execute the benchmark.
5. Analyze the results and decide whether to keep or discard.
6. Call \`log_experiment\` to record the outcome.
7. Repeat from step 4 with a new idea.

Guidelines:
- Always parse the METRIC lines from run_experiment output to get exact values.
- Use status=keep only when the metric improves (or is the baseline).
- Use status=discard when the metric regresses or stays the same.
- Use status=crash when the benchmark fails to run.
- Provide clear, concise descriptions of what was tried in each iteration.
- When confidence reaches 🟢 (≥ 2.0×), the improvement is statistically significant.
- You have access to three tools: init_experiment, run_experiment, log_experiment.`;

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

  // ── Session manager ──────────────────────────────────────────────────
  const sessionId = keyId || "default";
  const manager = getManager(sessionId);

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
      "3. Create a benchmark script that prints `METRIC name=value` lines.",
      "4. I'll loop: run benchmark → analyze → keep/discard → repeat.\n",
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
