
"use strict";

const http = require("http");
const WebSocket = require("ws");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 8787);
const HOST = "127.0.0.1";

const UPSTREAM =
  "wss://ws-subscriptions-clob.polymarket.com/ws/market";

const MAX_CLIENTS = 10;
const MAX_TOKENS = 500;
const MAX_BUFFER = 1000000;
const MAX_MESSAGE = 65536;

// IMPORTANT:
// Use the same key in the dashboard HTML and website userscript.
// Replace this placeholder before exposing the tunnel.
const BRIDGE_KEY = "CHANGE_THIS_TO_A_LONG_RANDOM_SECRET";

// Dashboard and Polymarket website origins.
const ALLOWED_ORIGINS = new Set([
  "https://mbeta3996-lab.github.io",
  "https://polymarket.com",
  "https://www.polymarket.com"
]);

const clients = new Set();
const dashboardClients = new Set();
const websiteClients = new Set();
const tokens = new Set();

let upstream = null;
let upstreamConnected = false;
let upstreamPackets = 0;
let websitePackets = 0;
let dashboardPackets = 0;
let lastUpstreamPacket = null;
let lastWebsitePacket = null;
let retryDelay = 1000;

function json(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(JSON.stringify(data));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/health") {
    return json(res, 200, {
      ok: true,
      service: "crystal-edge-bridge",
      upstreamConnected,
      clients: clients.size,
      dashboardClients: dashboardClients.size,
      websiteClients: websiteClients.size,
      subscribedTokens: tokens.size,
      upstreamPackets,
      websitePackets,
      dashboardPackets,
      lastUpstreamPacket,
      lastWebsitePacket
    });
  }

  if (url.pathname === "/") {
    return json(res, 200, {
      ok: true,
      service: "crystal-edge-bridge",
      websocket: "/ws",
      health: "/health"
    });
  }

  return json(res, 404, { error: "Not found" });
});

const wss = new WebSocket.Server({
  noServer: true,
  perMessageDeflate: false,
  maxPayload: MAX_MESSAGE
});

function send(ws, payload) {
  if (ws.readyState !== WebSocket.OPEN) return false;

  if (ws.bufferedAmount > MAX_BUFFER) {
    ws.close(1013, "Client too slow");
    return false;
  }

  try {
    ws.send(
      typeof payload === "string"
        ? payload
        : JSON.stringify(payload)
    );
    return true;
  } catch {
    return false;
  }
}

function broadcastToDashboards(payload) {
  const data =
    typeof payload === "string"
      ? payload
      : JSON.stringify(payload);

  for (const ws of dashboardClients) {
    send(ws, data);
  }
}

function subscribeUpstream(ids, initial = false) {
  if (
    !upstreamConnected ||
    !upstream ||
    upstream.readyState !== WebSocket.OPEN ||
    !ids.length
  ) return;

  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);

    const message = initial
      ? {
          type: "market",
          assets_ids: batch
        }
      : {
          operation: "subscribe",
          assets_ids: batch
        };

    upstream.send(JSON.stringify(message));
  }
}

function connectUpstream() {
  if (
    upstream &&
    (
      upstream.readyState === WebSocket.OPEN ||
      upstream.readyState === WebSocket.CONNECTING
    )
  ) return;

  upstreamConnected = false;

  const ws = new WebSocket(UPSTREAM, {
    handshakeTimeout: 12000,
    perMessageDeflate: false
  });

  upstream = ws;

  ws.on("open", () => {
    if (upstream !== ws) return;

    upstreamConnected = true;
    retryDelay = 1000;

    subscribeUpstream([...tokens], true);

    broadcastToDashboards({
      bridge_status: "upstream_connected",
      timestamp: new Date().toISOString()
    });

    console.log("Polymarket CLOB connected");
  });

  ws.on("message", raw => {
    if (upstream !== ws) return;

    upstreamPackets++;
    lastUpstreamPacket = new Date().toISOString();

    // Forward original Polymarket packet unchanged.
    broadcastToDashboards(raw.toString());
  });

  ws.on("error", err => {
    if (upstream !== ws) return;

    upstreamConnected = false;
    console.error("CLOB upstream:", err.message);
  });

  ws.on("close", () => {
    if (upstream !== ws) return;

    upstreamConnected = false;
    upstream = null;

    broadcastToDashboards({
      bridge_status: "upstream_disconnected",
      timestamp: new Date().toISOString()
    });

    const delay = retryDelay;
    retryDelay = Math.min(30000, retryDelay * 2);

    console.log(`CLOB reconnect in ${delay}ms`);
    setTimeout(connectUpstream, delay);
  });
}

function validToken(value) {
  const id = String(value ?? "");
  return /^\d{1,100}$/.test(id) ? id : null;
}

function handleDashboardMessage(ws, msg) {
  if (msg.type === "subscribe") {
    if (!Array.isArray(msg.assets_ids)) return;

    const fresh = [];

    for (const value of msg.assets_ids) {
      const id = validToken(value);
      if (!id || tokens.has(id)) continue;
      if (tokens.size >= MAX_TOKENS) break;

      tokens.add(id);
      fresh.push(id);
    }

    subscribeUpstream(fresh, false);

    send(ws, {
      bridge_status: "subscription_received",
      added: fresh.length,
      totalTokens: tokens.size,
      timestamp: new Date().toISOString()
    });

    return;
  }

  if (msg.type === "ping") {
    send(ws, {
      type: "pong",
      timestamp: new Date().toISOString()
    });
  }
}

function handleWebsiteMessage(ws, msg) {
  if (
    msg.type !== "website_quote" &&
    msg.event !== "website_quote"
  ) return;

  const tokenId = validToken(
    msg.tokenId ||
    msg.asset_id ||
    msg.assetId
  );

  const side = String(msg.side || "").toUpperCase();

  if (!tokenId || !["BUY", "SELL"].includes(side)) {
    return;
  }

  const price = Number(msg.price);

  if (!Number.isFinite(price) || price <= 0 || price > 1) {
    return;
  }

  websitePackets++;
  lastWebsitePacket = new Date().toISOString();

  // Preserve source timestamp if supplied.
  const capturedAt =
    msg.capturedAt ||
    msg.timestamp ||
    lastWebsitePacket;

  broadcastToDashboards({
    type: "website_quote",
    source: "website",
    tokenId,
    side,
    price,
    priceCents: price * 100,
    decimalOdds: 1 / price,
    capturedAt,
    receivedAt: lastWebsitePacket
  });
}

wss.on("connection", (ws, request) => {
  clients.add(ws);

  let role = null;

  send(ws, {
    bridge_status: "connected",
    timestamp: new Date().toISOString()
  });

  ws.on("message", raw => {
    let msg;

    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (!role) {
      if (
        msg.type !== "hello" ||
        !["dashboard", "website"].includes(msg.role)
      ) {
        ws.close(1008, "Send hello role first");
        return;
      }

      role = msg.role;

      if (role === "dashboard") {
        dashboardClients.add(ws);

        send(ws, {
          bridge_status: upstreamConnected
            ? "upstream_connected"
            : "upstream_connecting",
          subscribedTokens: tokens.size
        });
      } else {
        websiteClients.add(ws);

        send(ws, {
          bridge_status: "website_connected"
        });
      }

      console.log(`${role} client connected`);
      return;
    }

    if (role === "dashboard") {
      dashboardPackets++;
      handleDashboardMessage(ws, msg);
    }

    if (role === "website") {
      handleWebsiteMessage(ws, msg);
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    dashboardClients.delete(ws);
    websiteClients.delete(ws);
  });

  ws.on("error", () => {
    clients.delete(ws);
    dashboardClients.delete(ws);
    websiteClients.delete(ws);
  });
});

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const origin = req.headers.origin || "";
  const key = url.searchParams.get("key");

  if (
    url.pathname !== "/ws" ||
    !ALLOWED_ORIGINS.has(origin) ||
    !BRIDGE_KEY ||
    key !== BRIDGE_KEY ||
    clients.size >= MAX_CLIENTS
  ) {
    socket.write(
      "HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"
    );
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, ws => {
    wss.emit("connection", ws, req);
  });
});

server.listen(PORT, HOST, () => {
  console.log(
    `Crystal Bridge listening on http://${HOST}:${PORT}`
  );
  connectUpstream();
});

process.on("SIGTERM", () => {
  try {
    upstream?.close();
  } catch {}

  for (const ws of clients) {
    try {
      ws.close();
    } catch {}
  }

  server.close(() => process.exit(0));
});
