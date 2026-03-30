# copilot-autoresearch

Autonomous experiment loop as a **Copilot CLI plugin** — run, measure, keep or discard.

## What is this?

`copilot-autoresearch` brings the autonomous optimization loop from [pi-autoresearch](../pi-autoresearch/) into the GitHub Copilot CLI ecosystem. It provides:

- A **custom agent** (`autoresearch`) that manages the experiment loop
- **Skills** for setting up (`autoresearch-create`) and finalizing (`autoresearch-finalize`) sessions
- **MCP tools** (`init_experiment`, `run_experiment`, `log_experiment`) for the experiment lifecycle

The experiment loop runs autonomously: edit code → run benchmark → keep/discard → repeat.

## Relationship to pi-autoresearch

| | pi-autoresearch | copilot-autoresearch |
|---|---|---|
| **Platform** | Pi AI coding agent extension | Copilot CLI plugin |
| **Language** | TypeScript (Pi SDK) | TypeScript (MCP SDK) |
| **Interface** | Pi chat + dashboard widget | Copilot CLI agent + skills |
| **State** | JSONL + in-memory runtime | JSONL + in-memory manager |
| **Core loop** | Same | Same |

## Plugin structure

```
copilot-autoresearch/
├── plugin.json           Plugin manifest
├── .mcp.json             MCP server configuration
├── agents/
│   └── autoresearch.agent.md   Custom agent with loop instructions
├── skills/
│   ├── autoresearch-create/
│   │   └── SKILL.md            Setup and loop instructions
│   └── autoresearch-finalize/
│       ├── SKILL.md            Group and branch finalization guide
│       └── finalize.sh         Shell script for creating independent branches
├── src/
│   ├── index.ts          MCP stdio server entry point
│   ├── tools.ts          MCP tool registration
│   ├── experiment.ts     ExperimentManager — state, persistence, confidence scoring
│   └── types.ts          TypeScript interfaces
└── tests/
    └── finalize_test.sh  Test suite for finalize.sh
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

The MCP server parses these to extract measurements automatically.

## Setup

### Prerequisites

- Node.js 20+
- [Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli)

### Build the MCP server

```bash
cd copilot-autoresearch
npm install
npm run build
```

### Install as a Copilot CLI plugin

```bash
# From the repository root
copilot plugin install ./copilot-autoresearch

# Verify installation
copilot plugin list
```

### Usage

Start a Copilot CLI session and use the autoresearch agent or skills:

```bash
# Start an interactive session
copilot

# Use the autoresearch agent
/agent autoresearch

# Or invoke the setup skill directly
/skills autoresearch-create
```

The agent will guide you through:
1. Defining an optimization target
2. Creating benchmark scripts
3. Running the autonomous experiment loop

To finalize results into clean branches:
```
/skills autoresearch-finalize
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
