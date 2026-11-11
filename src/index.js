import crypto from "node:crypto";
import dns from "node:dns";
import express from "express";
import mongoose from "mongoose";
import pino from "pino";
import { SessionManager } from "./sessions.js";

const PORT = Number(process.env.PORT || 8787);
const MONGODB_URI = process.env.MONGODB_URI || "";
const GATEWAY_SECRET = process.env.GATEWAY_SECRET || "";

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

// Some networks (and macOS) cannot resolve the SRV record Atlas uses for
// mongodb+srv:// URIs. Setting DNS_SERVERS to a public resolver fixes that
// without rewriting the connection string.
if (process.env.DNS_SERVERS) {
  const servers = process.env.DNS_SERVERS.split(",").map((value) => value.trim()).filter(Boolean);
  if (servers.length) {
    dns.setServers(servers);
    logger.info({ servers }, "using custom DNS resolvers");
  }
}

if (!MONGODB_URI) {
  logger.error("MONGODB_URI is required.");
  process.exit(1);
}
if (!GATEWAY_SECRET || GATEWAY_SECRET.length < 16) {
  logger.error("GATEWAY_SECRET is required and must be at least 16 characters.");
  process.exit(1);
}

const manager = new SessionManager(logger);
const app = express();

app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));
app.use((req, res, next) => {
  res.setHeader("x-content-type-options", "nosniff");
  next();
});

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "instapay-whatsapp-gateway",
    uptimeSeconds: Math.round(process.uptime()),
    sessions: manager.sessions.size,
  });
});

app.use((req, res, next) => {
  const provided =
    req.get("x-gateway-secret") || (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!safeEqual(provided, GATEWAY_SECRET)) {
    return res.status(401).json({ error: { code: "unauthorized", message: "Invalid gateway secret." } });
  }
  next();
});

function sessionId(req, res, next) {
  const id = String(req.params.id || "");
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(id)) {
    return res.status(400).json({ error: { code: "invalid_session_id", message: "Invalid session id." } });
  }
  next();
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

app.get(
  "/sessions",
  asyncRoute(async (req, res) => {
    const rows = await manager.list();
    res.json({ sessions: rows });
  }),
);

app.get(
  "/sessions/:id",
  sessionId,
  asyncRoute(async (req, res) => {
    res.json({ session: await manager.status(req.params.id) });
  }),
);

app.post(
  "/sessions/:id/connect",
  sessionId,
  asyncRoute(async (req, res) => {
    const session = await manager.connect(req.params.id);
    res.json({ ok: true, session });
  }),
);

app.post(
  "/sessions/:id/logout",
  sessionId,
  asyncRoute(async (req, res) => {
    const session = await manager.logout(req.params.id);
    res.json({ ok: true, session });
  }),
);

app.delete(
  "/sessions/:id",
  sessionId,
  asyncRoute(async (req, res) => {
    const session = await manager.logout(req.params.id);
    res.json({ ok: true, session });
  }),
);

app.post(
  "/sessions/:id/send",
  sessionId,
  asyncRoute(async (req, res) => {
    const { to, message } = req.body || {};
    const result = await manager.send(req.params.id, to, message);
    res.json({ ok: true, id: result.id, jid: result.jid, phone: result.phone });
  }),
);

app.use((req, res) => {
  res.status(404).json({ error: { code: "not_found", message: "Unknown endpoint." } });
});

app.use((error, req, res, next) => {
  const status = Number(error.status) || 500;
  if (status >= 500) logger.error({ error: error.message, path: req.path }, "request failed");
  res.status(status).json({
    error: {
      code: error.code || "internal_error",
      message: status >= 500 ? "The gateway could not complete the request." : error.message,
    },
  });
});

async function start() {
  await mongoose.connect(MONGODB_URI, {
    maxPoolSize: 5,
    serverSelectionTimeoutMS: 10_000,
  });
  logger.info("connected to MongoDB");

  await manager.init();

  const server = app.listen(PORT, () => {
    logger.info({ port: PORT }, "WhatsApp gateway listening");
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");
    server.close();
    await manager.shutdown().catch(() => undefined);
    await mongoose.disconnect().catch(() => undefined);
    setTimeout(() => process.exit(0), 500).unref();
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

start().catch((error) => {
  logger.error({ error: error.message }, "gateway failed to start");
  process.exit(1);
});
