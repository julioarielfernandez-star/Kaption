/**
 * Thin wrapper around whatsapp-web.js that manages a single persistent
 * WhatsApp Web session and exposes convenient async methods for the MCP tools.
 *
 * The WhatsApp client drives a headless Chromium through Puppeteer. On first
 * run it needs to be linked to a phone by scanning a QR code (WhatsApp app ->
 * Settings -> Linked devices). The session is then persisted on disk via
 * LocalAuth, so subsequent starts reconnect automatically.
 *
 * IMPORTANT: this file must never write to stdout. stdout is reserved for the
 * MCP JSON-RPC stream. All human-facing logging goes to stderr.
 */

import pkg from "whatsapp-web.js";
import type { Chat, Message, Contact } from "whatsapp-web.js";
import qrcodeTerminal from "qrcode-terminal";

const { Client, LocalAuth } = pkg;

export type ConnectionState =
  | "initializing"
  | "qr" // waiting for the QR code to be scanned
  | "authenticated"
  | "ready"
  | "auth_failure"
  | "disconnected";

export interface ChatSummary {
  id: string;
  name: string;
  isGroup: boolean;
  unreadCount: number;
  timestamp: number | null; // unix seconds of last activity
  lastMessage: string | null;
}

export interface MessageSummary {
  id: string;
  chatId: string;
  from: string;
  author: string | null; // sender inside a group
  fromMe: boolean;
  timestamp: number; // unix seconds
  type: string;
  hasMedia: boolean;
  body: string;
}

export interface ContactSummary {
  id: string;
  name: string;
  pushname: string | null;
  number: string;
  isMyContact: boolean;
  isGroup: boolean;
  isBusiness: boolean;
}

function log(...args: unknown[]): void {
  // stderr only — stdout is the MCP protocol channel.
  console.error("[whatsapp]", ...args);
}

class WhatsAppService {
  private client: InstanceType<typeof Client> | null = null;
  private state: ConnectionState = "initializing";
  private lastQr: string | null = null;
  private lastError: string | null = null;
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;

  /**
   * Kick off the WhatsApp client. Safe to call once at startup; further calls
   * are no-ops. Does not block — connection happens in the background and the
   * state can be polled through getStatus().
   */
  start(): void {
    if (this.client) return;

    // Fresh attempt: reset readiness state (important when re-initializing
    // after a `disconnected` event tore the previous client down).
    this.state = "initializing";

    const dataPath =
      process.env.WHATSAPP_SESSION_PATH || "./.wwebjs_auth";
    const headless = process.env.WHATSAPP_HEADLESS !== "false";

    const puppeteer: Record<string, unknown> = {
      headless,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
      ],
    };
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      puppeteer.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }

    this.readyPromise = new Promise((resolve) => {
      this.readyResolve = resolve;
    });

    this.client = new Client({
      authStrategy: new LocalAuth({ dataPath }),
      puppeteer: puppeteer as never,
    });

    this.client.on("qr", (qr: string) => {
      this.state = "qr";
      this.lastQr = qr;
      log(
        "Scan this QR code with WhatsApp -> Settings -> Linked devices:",
      );
      // Render to stderr so it is visible in the terminal without corrupting stdout.
      qrcodeTerminal.generate(qr, { small: true }, (art) =>
        console.error(art),
      );
    });

    this.client.on("authenticated", () => {
      this.state = "authenticated";
      this.lastQr = null;
      log("Authenticated. Finishing sync…");
    });

    this.client.on("auth_failure", (msg: string) => {
      this.state = "auth_failure";
      this.lastError = msg;
      log("Authentication failure:", msg);
    });

    this.client.on("ready", () => {
      this.state = "ready";
      this.lastQr = null;
      log("Client is ready.");
      this.readyResolve?.();
    });

    this.client.on("disconnected", (reason: string) => {
      this.state = "disconnected";
      this.lastError = reason;
      log("Disconnected:", reason);
      // Tear the client down so the next operation re-initializes a fresh one.
      // Without this, `start()` stays a no-op (client is still set) and
      // `ensureReady()` keeps returning the dead client — every tool call would
      // fail until the whole process restarts.
      const dead = this.client;
      this.client = null;
      this.readyPromise = null;
      this.readyResolve = null;
      dead?.destroy().catch(() => {
        /* already gone — nothing to clean up */
      });
    });

    this.client.initialize().catch((err: unknown) => {
      this.state = "auth_failure";
      this.lastError = err instanceof Error ? err.message : String(err);
      log("Failed to initialize:", this.lastError);
    });
  }

  getStatus(): {
    state: ConnectionState;
    qr: string | null;
    error: string | null;
  } {
    return { state: this.state, qr: this.lastQr, error: this.lastError };
  }

  /**
   * Ensure the client is ready before running an operation. Waits up to
   * `timeoutMs` for the "ready" event, otherwise throws an actionable error.
   */
  private async ensureReady(timeoutMs = 20_000): Promise<InstanceType<typeof Client>> {
    // A prior `disconnected` event nulls the client; recreate it here so the
    // session can come back without restarting the process.
    if (!this.client || this.state === "disconnected") {
      this.start();
    }
    if (this.state === "ready") {
      return this.client!;
    }
    if (this.state === "qr") {
      throw new Error(
        "WhatsApp is not linked yet. A QR code is waiting to be scanned. " +
          "Open WhatsApp on your phone -> Settings -> Linked devices -> Link a device, " +
          "and scan the QR shown in the server terminal. Then retry. " +
          "Use the whatsapp_status tool to fetch the current QR string.",
      );
    }
    if (this.state === "auth_failure") {
      throw new Error(
        `WhatsApp authentication failed: ${this.lastError ?? "unknown error"}. ` +
          "Delete the session directory and restart to re-link.",
      );
    }

    // initializing / authenticated -> wait a bounded time for readiness.
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              `WhatsApp is still connecting (state: ${this.state}). ` +
                "Retry shortly, or check whatsapp_status.",
            ),
          ),
        timeoutMs,
      ),
    );
    await Promise.race([this.readyPromise ?? Promise.resolve(), timeout]);
    return this.client!;
  }

  async listChats(options: {
    limit: number;
    includeGroups: boolean;
    onlyUnread: boolean;
  }): Promise<ChatSummary[]> {
    const client = await this.ensureReady();
    let chats = await client.getChats();

    if (!options.includeGroups) {
      chats = chats.filter((c) => !c.isGroup);
    }
    if (options.onlyUnread) {
      chats = chats.filter((c) => c.unreadCount > 0);
    }

    // getChats() is already sorted by most-recent activity.
    return chats.slice(0, options.limit).map((c) => this.toChatSummary(c));
  }

  async readChat(options: {
    chatId?: string;
    name?: string;
    limit: number;
  }): Promise<{ chat: ChatSummary; messages: MessageSummary[] }> {
    const client = await this.ensureReady();
    const chat = await this.resolveChat(client, options.chatId, options.name);
    const messages = await chat.fetchMessages({ limit: options.limit });
    return {
      chat: this.toChatSummary(chat),
      messages: messages.map((m) => this.toMessageSummary(m)),
    };
  }

  async searchMessages(options: {
    query: string;
    chatId?: string;
    limit: number;
  }): Promise<MessageSummary[]> {
    const client = await this.ensureReady();
    const searchOptions: { limit: number; chatId?: string } = {
      limit: options.limit,
    };
    if (options.chatId) searchOptions.chatId = options.chatId;
    const messages = await client.searchMessages(options.query, searchOptions);
    return messages.map((m) => this.toMessageSummary(m));
  }

  async listContacts(options: {
    search?: string;
    limit: number;
  }): Promise<ContactSummary[]> {
    const client = await this.ensureReady();
    let contacts = await client.getContacts();
    contacts = contacts.filter((c) => c.isMyContact || c.isBusiness);

    if (options.search) {
      const q = options.search.toLowerCase();
      contacts = contacts.filter((c) => {
        const name = (c.name || c.pushname || "").toLowerCase();
        const number = (c.number || "").toLowerCase();
        return name.includes(q) || number.includes(q);
      });
    }
    return contacts
      .slice(0, options.limit)
      .map((c) => this.toContactSummary(c));
  }

  async sendMessage(options: {
    chatId?: string;
    name?: string;
    message: string;
  }): Promise<{ chatId: string; messageId: string }> {
    const client = await this.ensureReady();
    const chat = await this.resolveChat(
      client,
      options.chatId,
      options.name,
      true, // require a unique match before sending a real message
    );
    const sent = await client.sendMessage(
      chat.id._serialized,
      options.message,
    );
    return {
      chatId: chat.id._serialized,
      messageId: sent.id._serialized,
    };
  }

  // --- helpers ---------------------------------------------------------------

  private async resolveChat(
    client: InstanceType<typeof Client>,
    chatId?: string,
    name?: string,
    requireUnique = false,
  ): Promise<Chat> {
    if (chatId) {
      return client.getChatById(chatId);
    }
    if (name) {
      const chats = await client.getChats();
      const needle = name.toLowerCase();
      // Prefer exact name matches; fall back to substring matches only when
      // there is no exact hit.
      const exact = chats.filter((c) => (c.name || "").toLowerCase() === needle);
      const candidates =
        exact.length > 0
          ? exact
          : chats.filter((c) => (c.name || "").toLowerCase().includes(needle));

      if (candidates.length === 0) {
        throw new Error(
          `No chat found matching name "${name}". Use whatsapp_list_chats to see available chats, ` +
            "or pass an explicit chatId.",
        );
      }
      // When the side effect is irreversible (sending), never guess between
      // several matches — force the caller to disambiguate with a chatId.
      if (requireUnique && candidates.length > 1) {
        const list = candidates
          .slice(0, 10)
          .map((c) => `"${c.name || "(no name)"}" [${c.id._serialized}]`)
          .join(", ");
        throw new Error(
          `Ambiguous recipient: ${candidates.length} chats match "${name}": ${list}. ` +
            "Pass an explicit chatId to choose the exact recipient.",
        );
      }
      return candidates[0];
    }
    throw new Error("Either chatId or name must be provided.");
  }

  private toChatSummary(chat: Chat): ChatSummary {
    const last = chat.lastMessage;
    return {
      id: chat.id._serialized,
      name: chat.name || chat.id.user || chat.id._serialized,
      isGroup: chat.isGroup,
      unreadCount: chat.unreadCount,
      timestamp: chat.timestamp ?? null,
      lastMessage: last ? this.previewBody(last) : null,
    };
  }

  private toMessageSummary(m: Message): MessageSummary {
    return {
      id: m.id._serialized,
      chatId: m.id.remote || "",
      from: m.from,
      author: m.author ?? null,
      fromMe: m.fromMe,
      timestamp: m.timestamp,
      type: m.type,
      hasMedia: m.hasMedia,
      body: this.previewBody(m),
    };
  }

  private toContactSummary(c: Contact): ContactSummary {
    return {
      id: c.id._serialized,
      name: c.name || c.pushname || c.number || c.id._serialized,
      pushname: c.pushname ?? null,
      number: c.number || "",
      isMyContact: c.isMyContact,
      isGroup: c.isGroup,
      isBusiness: c.isBusiness,
    };
  }

  private previewBody(m: Message): string {
    if (m.body && m.body.trim().length > 0) return m.body;
    if (m.hasMedia) return `[${m.type} media]`;
    return `[${m.type}]`;
  }
}

export const whatsapp = new WhatsAppService();
