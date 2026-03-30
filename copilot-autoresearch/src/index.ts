import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { ExperimentManager } from "./experiment.js";
import { registerTools } from "./tools.js";

const manager = new ExperimentManager();
await manager.loadFromDisk();

const server = new McpServer({
  name: "autoresearch",
  version: "1.0.0",
});

registerTools(server, manager);

const transport = new StdioServerTransport();
await server.connect(transport);
