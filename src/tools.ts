/**
 * MCP tool definitions for the WhatsApp server.
 *
 * All read tools are annotated readOnly. `whatsapp_send_message` writes to the
 * outside world, so it is marked non-read-only / non-idempotent.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { whatsapp } from "./whatsapp.js";

/** Wrap a value as a text tool result carrying pretty JSON. */
function jsonResult(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
    structuredContent: data as Record<string, unknown>,
  };
}

/** Wrap an error as an actionable tool error result. */
function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: message,
      },
    ],
  };
}

export function registerTools(server: McpServer): void {
  server.registerTool(
    "whatsapp_status",
    {
      title: "WhatsApp connection status",
      description:
        "Report the WhatsApp Web connection state. If the account is not linked " +
        "yet, returns the pending QR code string to scan (WhatsApp -> Settings -> " +
        "Linked devices). Call this first to confirm the session is ready.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      const status = whatsapp.getStatus();
      return jsonResult({
        state: status.state,
        ready: status.state === "ready",
        qr: status.qr,
        error: status.error,
        hint:
          status.state === "qr"
            ? "Scan the qr string with your phone to finish linking."
            : status.state === "ready"
              ? "Connected. You can read and search chats."
              : "Still connecting — retry shortly.",
      });
    },
  );

  server.registerTool(
    "whatsapp_list_chats",
    {
      title: "List WhatsApp chats",
      description:
        "List recent WhatsApp chats, most recently active first. Returns chat id " +
        "(use it with other tools), name, group flag, unread count and a preview " +
        "of the last message.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .default(30)
          .describe("Maximum number of chats to return (default 30)."),
        includeGroups: z
          .boolean()
          .default(true)
          .describe("Include group chats (default true)."),
        onlyUnread: z
          .boolean()
          .default(false)
          .describe("Only return chats with unread messages (default false)."),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ limit, includeGroups, onlyUnread }) => {
      try {
        const chats = await whatsapp.listChats({
          limit,
          includeGroups,
          onlyUnread,
        });
        return jsonResult({ count: chats.length, chats });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "whatsapp_read_chat",
    {
      title: "Read messages from a WhatsApp chat",
      description:
        "Fetch recent messages from a single chat, oldest to newest. Identify the " +
        "chat by chatId (preferred, from whatsapp_list_chats) or by name (fuzzy " +
        "match). Messages include sender, timestamp, type and text body.",
      inputSchema: {
        chatId: z
          .string()
          .optional()
          .describe(
            "Chat id, e.g. '5491157447139@c.us' or a group id. Preferred over name.",
          ),
        name: z
          .string()
          .optional()
          .describe(
            "Chat/contact name to fuzzy-match if chatId is not known.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .default(30)
          .describe("Number of most recent messages to fetch (default 30)."),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ chatId, name, limit }) => {
      try {
        const result = await whatsapp.readChat({ chatId, name, limit });
        return jsonResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "whatsapp_search_messages",
    {
      title: "Search WhatsApp messages",
      description:
        "Full-text search across WhatsApp messages. Optionally restrict to a " +
        "single chat with chatId. Returns matching messages with their chat and " +
        "sender context.",
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe("Text to search for."),
        chatId: z
          .string()
          .optional()
          .describe("Restrict the search to this chat id (optional)."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(25)
          .describe("Maximum number of matches to return (default 25)."),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ query, chatId, limit }) => {
      try {
        const messages = await whatsapp.searchMessages({ query, chatId, limit });
        return jsonResult({ count: messages.length, messages });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "whatsapp_list_contacts",
    {
      title: "List WhatsApp contacts",
      description:
        "List saved WhatsApp contacts (and business contacts). Optionally filter " +
        "by a search term matched against name or phone number.",
      inputSchema: {
        search: z
          .string()
          .optional()
          .describe("Filter contacts by name or number (optional)."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .default(100)
          .describe("Maximum number of contacts to return (default 100)."),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ search, limit }) => {
      try {
        const contacts = await whatsapp.listContacts({ search, limit });
        return jsonResult({ count: contacts.length, contacts });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "whatsapp_send_message",
    {
      title: "Send a WhatsApp message",
      description:
        "Send a text message to a chat. Identify the chat by chatId (preferred) or " +
        "name. This posts a real message to WhatsApp — use with care.",
      inputSchema: {
        chatId: z
          .string()
          .optional()
          .describe("Destination chat id, e.g. '5491157447139@c.us'."),
        name: z
          .string()
          .optional()
          .describe("Destination chat/contact name to fuzzy-match if chatId is unknown."),
        message: z
          .string()
          .min(1)
          .describe("The text message to send."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ chatId, name, message }) => {
      try {
        const result = await whatsapp.sendMessage({ chatId, name, message });
        return jsonResult({ sent: true, ...result });
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
