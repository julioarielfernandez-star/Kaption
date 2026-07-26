# Kaption WhatsApp MCP

An [MCP](https://modelcontextprotocol.io) server that exposes **WhatsApp** to an
LLM client (Claude Code, Claude Desktop, etc.) so it can **read chats, search
messages, list contacts and send messages**.

It connects through **WhatsApp Web** using
[`whatsapp-web.js`](https://github.com/pedroslopez/whatsapp-web.js), which drives
a headless Chromium and links to your phone via a QR code. This is the only
approach that can read your **existing** personal chat history — the official
WhatsApp Cloud API cannot.

> ⚠️ **Heads up:** `whatsapp-web.js` is an unofficial library and using it is
> against WhatsApp's Terms of Service. There is a real (if small) risk of your
> number being blocked. Use a number you control and understand the risk. The
> session data under `.wwebjs_auth/` are credentials — never commit or share it
> (it is already git-ignored).

## Tools

| Tool | Read/Write | Description |
| --- | --- | --- |
| `whatsapp_status` | read | Connection state; returns the pending QR string when not yet linked. |
| `whatsapp_list_chats` | read | Recent chats (id, name, group flag, unread count, last-message preview). |
| `whatsapp_read_chat` | read | Recent messages from one chat (by `chatId` or fuzzy `name`). |
| `whatsapp_search_messages` | read | Full-text search across messages, optionally scoped to a chat. |
| `whatsapp_list_contacts` | read | Saved/business contacts, optional search filter. |
| `whatsapp_send_message` | write | Send a text message to a chat. |

## Requirements

- Node.js ≥ 20
- A machine with outbound network access to `web.whatsapp.com` (this will **not**
  work inside a sandboxed environment whose network policy blocks WhatsApp, such
  as Claude Code on the web — run it locally).
- A phone with WhatsApp to scan the QR code the first time.

## Install & build

```bash
npm install
npm run build
```

Chromium is downloaded automatically by Puppeteer during `npm install`. If you
already have a Chrome/Chromium, point to it with `PUPPETEER_EXECUTABLE_PATH`.

## First run & linking

Start the server directly to see the QR code (it is printed to **stderr**, so it
never corrupts the MCP protocol on stdout):

```bash
npm start
```

On the phone: **WhatsApp → Settings → Linked devices → Link a device**, then scan
the QR shown in the terminal. After linking, the session is saved under
`.wwebjs_auth/` and future starts reconnect automatically. You can also fetch the
current QR string programmatically via the `whatsapp_status` tool.

## Configuration (environment variables)

| Variable | Default | Purpose |
| --- | --- | --- |
| `WHATSAPP_SESSION_PATH` | `./.wwebjs_auth` | Where the linked-session credentials are stored. |
| `WHATSAPP_HEADLESS` | `true` | Set to `false` to watch the Chromium window (useful for debugging). |
| `PUPPETEER_EXECUTABLE_PATH` | _(unset)_ | Use an existing Chromium/Chrome binary instead of the bundled one. |

## Connecting to Claude Code

Register it as a **local (stdio)** MCP server pointing at the built entry point:

```bash
claude mcp add kaption-whatsapp -- node /absolute/path/to/Kaption/dist/index.js
```

Or add it to your MCP client config manually:

```json
{
  "mcpServers": {
    "kaption-whatsapp": {
      "command": "node",
      "args": ["/absolute/path/to/Kaption/dist/index.js"],
      "env": {
        "WHATSAPP_SESSION_PATH": "/absolute/path/to/Kaption/.wwebjs_auth"
      }
    }
  }
}
```

The first time the client starts the server, run `npm start` once in a terminal
to scan the QR (or check the client's MCP server logs for the QR on stderr).
Once `whatsapp_status` reports `state: "ready"`, the read/search/send tools work.

## Project layout

```
src/
  index.ts      # MCP server entry (stdio transport)
  tools.ts      # MCP tool definitions (Zod schemas + annotations)
  whatsapp.ts   # whatsapp-web.js session wrapper (state, QR, methods)
```

## Notes on the sandbox network limit

If you tried to add the hosted endpoint
`https://mcp-ext.kaptionai.com/sse?phone=...` from Claude Code on the web and saw
*"Needs authentication"* / a `403` at the proxy, that is the web environment's
network policy blocking the domain — not a WhatsApp auth problem. Running this
server locally avoids that restriction entirely.
