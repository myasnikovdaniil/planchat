// Phase 0 spike: minimal MCP server that declares claude/channel and pushes
// a channel notification every 15 s. Logs to $SPIKE_LOG.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { appendFileSync } from "node:fs";

const log = (m: string) => appendFileSync(process.env.SPIKE_LOG ?? "/dev/null", `${new Date().toISOString()} ${m}\n`);

const mcp = new Server(
  { name: "spike", version: "0.0.1" },
  {
    capabilities: { tools: {}, experimental: { "claude/channel": {} } },
    instructions: 'Events from spike arrive as <channel source="spike">. When one arrives, call the spike_ping tool with its n.',
  },
);
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: "spike_ping", description: "Acknowledge a spike channel event", inputSchema: { type: "object", properties: { n: { type: "string" } } } }],
}));
mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  log(`tool ${req.params.name} ${JSON.stringify(req.params.arguments)}`);
  return { content: [{ type: "text", text: "pong" }] };
});
mcp.oninitialized = () => {
  log(`initialized; client=${JSON.stringify(mcp.getClientVersion())} caps=${JSON.stringify(mcp.getClientCapabilities())}`);
  let n = 0;
  setInterval(async () => {
    n++;
    try {
      await mcp.notification({ method: "notifications/claude/channel", params: { content: `spike event ${n}`, meta: { n: String(n), kind: "tick" } } });
      log(`sent ${n}`);
    } catch (e) { log(`send failed ${e}`); }
  }, 15000);
};
await mcp.connect(new StdioServerTransport());
log("connected");
