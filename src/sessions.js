import mongoose from "mongoose";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import pino from "pino";
import QRCode from "qrcode";
import { useMongoAuthState } from "./auth-state.js";
import { toWhatsAppJid } from "./phone.js";

const SessionSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, unique: true, index: true },
    enabled: { type: Boolean, default: false },
    status: { type: String, default: "disconnected" },
    phone: { type: String, default: "" },
    pushName: { type: String, default: "" },
    lastError: { type: String, default: null },
  },
  { timestamps: true },
);

export const GatewaySession =
  mongoose.models.WhatsAppGatewaySession ||
  mongoose.model("WhatsAppGatewaySession", SessionSchema, "whatsapp_gateway_sessions");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function httpError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function describeError(error) {
  if (!error) return "Unknown error";
  if (typeof error === "string") return error;
  return error.message || String(error);
}

/**
 * One Baileys socket per merchant. The map is the source of truth while the
 * process is alive; the Mongo document is the durable copy used on restart.
 */
export class SessionManager {
  constructor(logger) {
    this.logger = logger;
    this.sessions = new Map();
    this.version = null;
    this.baileysLogger = pino({ level: process.env.BAILEYS_LOG_LEVEL || "silent" });
  }

  async init() {
    try {
      const { version } = await fetchLatestBaileysVersion();
      this.version = version;
      this.logger.info({ version }, "using WhatsApp Web version");
    } catch (error) {
      this.logger.warn({ error: describeError(error) }, "could not fetch the latest WhatsApp version; using the bundled default");
    }

    const enabled = await GatewaySession.find({ enabled: true }).lean();
    for (const doc of enabled) {
      const auth = await useMongoAuthState(doc.sessionId);
      if (!(await auth.hasCreds())) {
        await GatewaySession.updateOne(
          { sessionId: doc.sessionId },
          { $set: { enabled: false, status: "disconnected", lastError: "No saved credentials." } },
        );
        continue;
      }
      this.logger.info({ sessionId: doc.sessionId }, "restoring WhatsApp session");
      void this.startSocket(doc.sessionId).catch((error) => {
        this.logger.error({ sessionId: doc.sessionId, error: describeError(error) }, "restore failed");
      });
    }
  }

  runtime(id) {
    let runtime = this.sessions.get(id);
    if (!runtime) {
      runtime = {
        id,
        sock: null,
        status: "disconnected",
        qr: null,
        qrRaw: null,
        phone: "",
        pushName: "",
        lastError: null,
        updatedAt: new Date(),
        starting: null,
        reconnectTimer: null,
        retries: 0,
        stopping: false,
      };
      this.sessions.set(id, runtime);
    }
    return runtime;
  }

  snapshot(runtime) {
    return {
      id: runtime.id,
      status: runtime.status,
      qr: runtime.status === "qr" ? runtime.qr : null,
      phone: runtime.phone,
      pushName: runtime.pushName,
      lastError: runtime.lastError,
      updatedAt: runtime.updatedAt instanceof Date ? runtime.updatedAt.toISOString() : runtime.updatedAt,
    };
  }

  async status(id) {
    const runtime = this.sessions.get(id);
    if (runtime) return this.snapshot(runtime);

    const doc = await GatewaySession.findOne({ sessionId: id }).lean();
    const status = doc?.status === "connected" ? "disconnected" : doc?.status || "disconnected";
    return {
      id,
      status,
      qr: null,
      phone: doc?.phone || "",
      pushName: doc?.pushName || "",
      lastError: doc?.lastError || null,
      updatedAt: doc?.updatedAt ? new Date(doc.updatedAt).toISOString() : null,
    };
  }

  async list() {
    const docs = await GatewaySession.find({}).sort({ updatedAt: -1 }).lean();
    return docs.map((doc) => {
      const runtime = this.sessions.get(doc.sessionId);
      return {
        id: doc.sessionId,
        status: runtime ? runtime.status : doc.status === "connected" ? "disconnected" : doc.status,
        phone: runtime?.phone || doc.phone || "",
        pushName: runtime?.pushName || doc.pushName || "",
        enabled: Boolean(doc.enabled),
        lastError: runtime?.lastError || doc.lastError || null,
        updatedAt: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : null,
      };
    });
  }

  async persist(runtime) {
    await GatewaySession.updateOne(
      { sessionId: runtime.id },
      {
        $set: {
          status: runtime.status,
          phone: runtime.phone,
          pushName: runtime.pushName,
          lastError: runtime.lastError,
          updatedAt: new Date(),
        },
      },
      { upsert: true },
    );
  }

  async connect(id) {
    await GatewaySession.updateOne(
      { sessionId: id },
      { $set: { enabled: true }, $setOnInsert: { status: "disconnected" } },
      { upsert: true },
    );

    const runtime = this.runtime(id);
    if (runtime.status === "connected" || runtime.status === "qr" || runtime.status === "connecting") {
      return this.snapshot(runtime);
    }

    await this.startSocket(id);
    await sleep(400);
    return this.snapshot(this.runtime(id));
  }

  async startSocket(id) {
    const runtime = this.runtime(id);
    if (runtime.starting) {
      await runtime.starting;
      return this.snapshot(runtime);
    }

    runtime.starting = (async () => {
      runtime.stopping = false;
      runtime.status = "connecting";
      runtime.qr = null;
      runtime.qrRaw = null;
      runtime.lastError = null;
      runtime.updatedAt = new Date();
      await this.persist(runtime);

      const auth = await useMongoAuthState(id);

      if (runtime.sock) {
        try {
          runtime.sock.ev.removeAllListeners("connection.update");
          runtime.sock.end(undefined);
        } catch {
          // The old socket may already be closed.
        }
        runtime.sock = null;
      }

      const sock = makeWASocket({
        version: this.version || undefined,
        auth: auth.state,
        logger: this.baileysLogger,
        printQRInTerminal: false,
        browser: Browsers.ubuntu("Chrome"),
        markOnlineOnConnect: false,
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
        shouldSyncHistoryMessage: () => false,
        getMessage: async () => undefined,
      });

      runtime.sock = sock;

      sock.ev.on("creds.update", auth.saveCreds);
      sock.ev.on("connection.update", (update) => {
        void this.handleUpdate(runtime, auth, update).catch((error) => {
          this.logger.error({ sessionId: id, error: describeError(error) }, "connection.update failed");
        });
      });

      this.logger.info({ sessionId: id }, "WhatsApp socket started");
    })()
      .catch(async (error) => {
        runtime.status = "error";
        runtime.lastError = describeError(error);
        runtime.updatedAt = new Date();
        await this.persist(runtime).catch(() => undefined);
        this.logger.error({ sessionId: id, error: describeError(error) }, "could not start WhatsApp socket");
      })
      .finally(() => {
        runtime.starting = null;
      });

    return runtime.starting;
  }

  async handleUpdate(runtime, auth, update) {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        runtime.qr = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
      } catch {
        runtime.qr = null;
      }
      runtime.qrRaw = qr;
      runtime.status = "qr";
      runtime.lastError = null;
      runtime.updatedAt = new Date();
      await this.persist(runtime);
      this.logger.info({ sessionId: runtime.id }, "QR code ready for scanning");
    }

    if (connection === "open") {
      const user = runtime.sock?.user;
      const rawId = user?.id || "";
      runtime.phone = rawId.split(":")[0].split("@")[0] || runtime.phone;
      runtime.pushName = user?.name || user?.verifiedName || "";
      runtime.status = "connected";
      runtime.qr = null;
      runtime.qrRaw = null;
      runtime.lastError = null;
      runtime.retries = 0;
      runtime.updatedAt = new Date();
      await this.persist(runtime);
      this.logger.info({ sessionId: runtime.id, phone: runtime.phone }, "WhatsApp connected");
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      runtime.qr = null;
      runtime.qrRaw = null;
      runtime.sock = null;
      runtime.updatedAt = new Date();

      if (runtime.stopping) {
        return;
      }

      if (loggedOut) {
        await auth.clear().catch(() => undefined);
        runtime.status = "logged_out";
        runtime.phone = "";
        runtime.pushName = "";
        runtime.lastError = "The phone unlinked this WhatsApp session.";
        await this.persist(runtime);
        await GatewaySession.updateOne({ sessionId: runtime.id }, { $set: { enabled: false } });
        this.logger.warn({ sessionId: runtime.id }, "WhatsApp session logged out");
        return;
      }

      runtime.status = "disconnected";
      runtime.lastError = lastDisconnect?.error
        ? `Connection closed (${statusCode ?? "unknown"}): ${describeError(lastDisconnect.error)}`
        : "Connection closed.";
      await this.persist(runtime);
      this.scheduleReconnect(runtime);
    }
  }

  scheduleReconnect(runtime) {
    if (runtime.reconnectTimer) return;

    const delay = Math.min(30_000, 3_000 * 2 ** Math.min(runtime.retries, 4));
    runtime.retries += 1;

    runtime.reconnectTimer = setTimeout(() => {
      runtime.reconnectTimer = null;
      void (async () => {
        const doc = await GatewaySession.findOne({ sessionId: runtime.id }).lean();
        if (!doc?.enabled) return;
        await this.startSocket(runtime.id).catch(() => undefined);
      })();
    }, delay);

    runtime.reconnectTimer.unref?.();
    this.logger.info({ sessionId: runtime.id, delay }, "reconnecting WhatsApp");
  }

  async logout(id) {
    const runtime = this.runtime(id);
    runtime.stopping = true;
    if (runtime.reconnectTimer) {
      clearTimeout(runtime.reconnectTimer);
      runtime.reconnectTimer = null;
    }

    try {
      if (runtime.sock) await runtime.sock.logout();
    } catch {
      // Already disconnected.
    }

    try {
      runtime.sock?.end(undefined);
    } catch {
      // ignore
    }

    runtime.sock = null;
    runtime.qr = null;
    runtime.qrRaw = null;
    runtime.phone = "";
    runtime.pushName = "";
    runtime.status = "disconnected";
    runtime.lastError = null;
    runtime.updatedAt = new Date();

    const auth = await useMongoAuthState(id);
    await auth.clear().catch(() => undefined);

    await GatewaySession.updateOne(
      { sessionId: id },
      {
        $set: {
          enabled: false,
          status: "disconnected",
          phone: "",
          pushName: "",
          lastError: null,
          updatedAt: new Date(),
        },
      },
      { upsert: true },
    );

    return this.snapshot(runtime);
  }

  /**
   * Shared hosting may stop an idle Node.js process between requests. On wake
   * the socket is not up yet, so a send waits briefly for it instead of
   * failing the customer's OTP code.
   */
  async waitForConnection(id, timeoutMs = 12_000) {
    const runtime = this.runtime(id);
    if (runtime.status === "connected" && runtime.sock) return runtime;

    const doc = await GatewaySession.findOne({ sessionId: id }).lean();
    if (!doc?.enabled) return null;

    if (!runtime.starting && runtime.status !== "qr" && runtime.status !== "connecting") {
      void this.startSocket(id).catch(() => undefined);
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (runtime.status === "connected" && runtime.sock) return runtime;
      await sleep(400);
    }
    return null;
  }

  async send(id, to, message) {
    let runtime = this.sessions.get(id);
    if (!runtime || !runtime.sock || runtime.status !== "connected") {
      runtime = await this.waitForConnection(id);
    }

    if (!runtime || !runtime.sock || runtime.status !== "connected") {
      throw httpError(
        409,
        "whatsapp_disconnected",
        "WhatsApp is not connected. Open the dashboard, WhatsApp, and link the phone first.",
      );
    }

    const target = toWhatsAppJid(to);
    if (!target) throw httpError(400, "invalid_phone", "Enter a valid phone number, for example 201012345678.");

    const text = String(message ?? "").trim();
    if (!text) throw httpError(400, "empty_message", "The message is empty.");
    if (text.length > 4000) throw httpError(400, "message_too_long", "Keep the message under 4000 characters.");

    try {
      const sent = await runtime.sock.sendMessage(target.jid, { text });
      return { id: sent?.key?.id || "", jid: target.jid, phone: target.phone };
    } catch (error) {
      throw httpError(502, "whatsapp_send_failed", `WhatsApp could not send the message: ${describeError(error)}`);
    }
  }

  async shutdown() {
    for (const runtime of this.sessions.values()) {
      if (runtime.reconnectTimer) clearTimeout(runtime.reconnectTimer);
      try {
        runtime.sock?.end(undefined);
      } catch {
        // ignore
      }
    }
    this.sessions.clear();
  }
}
