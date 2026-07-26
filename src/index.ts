#!/usr/bin/env node
/**
 * Kaption WhatsApp MCP server.
 *
 * Exposes WhatsApp (via WhatsApp Web / whatsapp-web.js) as MCP tools over a
 * stdio transport, so an MCP client (Claude Code, etc.) can read chats, search
 * messages, list contacts and send messages.
 *
 * Transport: stdio. stdout carries the JSON-RPC protocol only — every log line
 * goes to stderr (see whatsapp.ts).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";
import { whatsapp } from "./whatsapp.js";

async function main(): Promise<void> {
  const server = new McpServer({
    name: "kaption-whatsapp",
    version: "0.1.0",
  });

  registerTools(server);

  // Start linking to WhatsApp in the background so the QR appears early. Tools
  // wait for readiness on demand, so we don't block server startup here.
  whatsapp.start();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[kaption-whatsapp] MCP server running on stdio.");
}

main().catch((err) => {
  console.error("[kaption-whatsapp] Fatal error:", err);
  process.exit(1);
});
