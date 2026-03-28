import express from "express";
import { agentHandler } from "./agent.js";

const PORT = parseInt(process.env.PORT ?? "3000", 10);

const app = express();

// Raw body middleware — needed for signature verification.
// We parse as text so the raw string is available for HMAC checks,
// then also expose the parsed JSON on req.body for convenience.
app.use(
  express.text({ type: "application/json", limit: "1mb" }),
);

// Health check
app.get("/", (_req, res) => {
  res.json({
    name: "copilot-autoresearch",
    version: "1.0.0",
    status: "ok",
    description:
      "Autonomous experiment loop — GitHub Copilot Extension",
  });
});

// Copilot agent endpoint
app.post("/agent", agentHandler);

app.listen(PORT, () => {
  console.log(`copilot-autoresearch listening on http://localhost:${PORT}`);
  console.log(`  POST /agent  — Copilot agent endpoint`);
  console.log(`  GET  /       — health check`);
});
