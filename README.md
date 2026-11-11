# InstaPay WhatsApp Gateway

A tiny always-on service that links a merchant's phone as a WhatsApp **linked
device** (the same feature as WhatsApp Web) and exposes a private HTTP API the
dashboard uses to send OTP codes and order updates.

- No Meta/Facebook developer app, no message templates, no per-message fees.
- Auth state is stored in MongoDB, so redeploys do not force a new QR scan.
- One session per dashboard user (`sessionId` = the dashboard user id).
- The dashboard holds the only secret; this service should not be public-facing
  without `GATEWAY_SECRET`.

## Why a separate service?

WhatsApp linked-device sessions need a persistent WebSocket. Vercel/serverless
functions are short-lived, so the gateway must run on an always-on Node host
(Render, Railway, Fly.io, a Hostinger VPS, Docker, etc.). It can scale to 0 only
if you accept that the session goes offline and messages fail while asleep.

## Run locally

```sh
cp .env.example .env
# set MONGODB_URI and GATEWAY_SECRET
npm install
npm run dev
```

Health check: `GET http://localhost:8787/health`.

## Docker

```sh
docker compose up -d --build
```

## API (all routes except /health need `x-gateway-secret`)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/sessions/:id` | Current status + QR data URL |
| POST | `/sessions/:id/connect` | Start/restart pairing |
| POST | `/sessions/:id/logout` | Unlink the phone |
| POST | `/sessions/:id/send` | `{ to, message }` |
| GET | `/sessions` | All sessions (metadata) |

`id` must match `^[A-Za-z0-9_-]{6,64}$`. The dashboard uses the Mongo user id.

## Deploy

Full instructions (Render, VPS, Vercel env vars, WordPress setup) are in
[`../docs/whatsapp.md`](../docs/whatsapp.md).

> Linked-device automation is not an official Meta API. Use a store number with
> human-scale volume; unsolicited bulk messaging can get a number restricted.
