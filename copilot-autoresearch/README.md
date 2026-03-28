# copilot-autoresearch

Autonomous experiment loop as a **GitHub Copilot Extension** — run, measure, keep or discard.

## What is this?

`copilot-autoresearch` brings the autonomous optimization loop from [pi-autoresearch](../pi-autoresearch/) into the GitHub Copilot ecosystem. It provides a Copilot chat agent (`@copilot-autoresearch`) that helps you:

1. **Define** an optimization target (metric name, direction)
2. **Run** a benchmark command and parse `METRIC name=value` lines from its output
3. **Decide** whether to keep or discard each iteration's changes
4. **Track** progress with MAD-based confidence scoring and JSONL persistence

The experiment loop runs autonomously: edit code → run benchmark → keep/discard → repeat.

## Relationship to pi-autoresearch

| | pi-autoresearch | copilot-autoresearch |
|---|---|---|
| **Platform** | Pi AI coding agent extension | GitHub Copilot Extension |
| **Language** | TypeScript (Pi SDK) | TypeScript (Express + Copilot SDK) |
| **Interface** | Pi chat + dashboard widget | GitHub Copilot Chat (SSE) |
| **State** | JSONL + in-memory runtime | JSONL + in-memory manager |
| **Core loop** | Same | Same |

## Architecture

```
src/
├── index.ts          Express server (POST /agent, GET /)
├── agent.ts          SSE handler — parses messages, dispatches tools, streams responses
├── tools.ts          Tool definitions (JSON Schema) + dispatch logic
├── experiment.ts     ExperimentManager — state, persistence, confidence scoring
└── types.ts          TypeScript interfaces
```

### Data flow

```
Copilot Chat ──POST /agent──▶ agent.ts ──tool call──▶ tools.ts ──▶ experiment.ts
                  ◀──SSE stream────────────────────────────────────────┘
```

## Available tools

| Tool | Description |
|------|-------------|
| `init_experiment` | Initialize a session with name, metric, and direction (lower/higher) |
| `run_experiment` | Execute a benchmark command, capture output, parse METRIC lines |
| `log_experiment` | Record result as keep/discard/crash with confidence scoring |

### METRIC format

Your benchmark script should print lines like:

```
METRIC total_µs=15200
METRIC compile_µs=4200
METRIC render_µs=9800
```

The agent parses these to extract measurements automatically.

## Setup

### Prerequisites

- Node.js 20+
- A GitHub App configured as a Copilot Extension

### Create the GitHub App

1. Go to **Settings → Developer settings → GitHub Apps → New GitHub App**
2. Set the **Callback URL** to your server's `/agent` endpoint
3. Under **Copilot**, enable the extension and set the endpoint to `https://your-server/agent`
4. Install the app on your account/organization

### Environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | HTTP server port | `3000` |
| `GITHUB_TOKEN` | Token for signature verification | _(skip verification)_ |

## Running locally

```bash
# Install dependencies
npm install

# Build
npm run build

# Start the server
npm start

# Or run in development mode (ts-node)
npm run dev
```

The server listens on `http://localhost:3000` by default.

### Testing the health check

```bash
curl http://localhost:3000/
```

### Sending a test message

```bash
curl -X POST http://localhost:3000/agent \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"I want to optimize my build time"}]}'
```

## Confidence scoring

Confidence is computed using **Median Absolute Deviation (MAD)**:

```
confidence = |best_improvement| / MAD
```

| Score | Indicator | Meaning |
|-------|-----------|---------|
| ≥ 2.0× | 🟢 | Improvement likely real |
| 1.0–2.0× | 🟡 | Above noise but marginal |
| < 1.0× | 🔴 | Within noise — re-run to confirm |

## License

MIT
