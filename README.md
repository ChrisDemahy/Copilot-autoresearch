# Autoresearch

Autonomous experiment loops for AI coding agents — run, measure, keep or discard.

This repository contains two implementations of the autoresearch concept:

| Package | Platform | Description |
|---------|----------|-------------|
| [`pi-autoresearch`](./pi-autoresearch/) | [Pi](https://github.com/mariozechner/pi) AI coding agent | Extension + skills for Pi's terminal-based agent |
| [`copilot-autoresearch`](./copilot-autoresearch/) | GitHub Copilot Extension | Express server using the `@copilot-extensions/preview-sdk` |

Both share the same core workflow:

1. **Define** an optimization target (metric name, direction)
2. **Run** a benchmark command that prints `METRIC name=value` lines
3. **Decide** whether to keep or discard each change based on the metric
4. **Track** progress with MAD-based confidence scoring and JSONL persistence
5. **Repeat** — loop forever until interrupted

## Getting started

See each package's README for setup and usage instructions:

- [pi-autoresearch README](./pi-autoresearch/README.md)
- [copilot-autoresearch README](./copilot-autoresearch/README.md)

## License

MIT
