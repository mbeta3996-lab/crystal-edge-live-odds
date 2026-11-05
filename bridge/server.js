"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const PORT = Number(process.env.PORT || 8787);
const HOST = "::";
const ROOT = process.env.DASHBOARD_DIR || "/opt/crystal-dashboard";
const INDEX = path.join(ROOT, "index.html");

const CLOB_WS = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const SPORTS_WS = "wss://sports-api.polymarket.com/ws";

const MAX_CLIENTS = 20;
const MAX_TOKENS = 500;
const MAX_MESSAGE = 65536;
const BRIDGE_KEY = process.env.BRIDGE_TOKEN || "";

const ALLOWED_ORIGINS = new Set([
  "http://[2a06:9801:700:0:69d:ac2f:66f1:eb88]:8787",
  "https://polymarket.com",
  "https://www.polymarket.com"
]);

const clients = new Set();
const dashboards = new Set();
const websites = new Set();
const tokens = new Set();
const quoteBooks = new Map();
const liveGames = new Map();

let clob = null;
let sports = null;
let clobConnected = false;
let sportsConnected = false;
let clobPackets = 0;
let sportsPackets = 0;
let websitePackets = 0;
let lastClobPacket = 0;
let lastSportsPacket = 0;
let lastWebsitePacket = 0;
let retryClob = 1000;
let retrySports = 1000;
let discoveryTimer = null;
let discoveryBusy = false;

function send(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(data));
    } catch {}
  }
}

function broadcast(data) {
  for (const ws of dashboards) send(ws, data);
}

function validToken(v) {
  return /^\d{10,}$/.test(String(v || ""));
}

function chunks(a, n) {
  const out = [];
  for (let i = 0; i < a.length; i += n) {
    out.push(a.slice(i, i + n));
  }
  return out;
}

function parseArray(v) {
  if (Array.isArray(v)) return v;

  if (typeof v === "string") {
    try {
      const x = JSON.parse(v);
      return Array.isArray(x) ? x : [];
    } catch {}
  }

  return [];
}

function sportFromLeague(v) {
  const s = String(v || "").toLowerCase();

  if (/cricket|ipl|t20|odi|test|bbl|psl|hundred|cpl|wpl|lpl|npl/.test(s)) {
    return "cricket";
  }

  if (/tennis|atp|wta|challenger|itf|grand.?slam/.test(s)) {
    return "tennis";
  }

  if (/soccer|football|epl|premier.?league|laliga|serie.?a|bundesliga|ligue.?1|ucl|mls/.test(s)) {
    return "football";
  }

  return null;
}

function isEnded(g) {
  const s = String(g.status || "").toLowerCase();

  return g.ended === true ||
    ["final", "finished", "ended", "ft", "ft ot", "ft nr",
     "awarded", "cancelled", "canceled"].includes(s);
}

function isLive(g) {
  const s = String(g.status || "").toLowerCase();

  return g.live === true ||
    ["inprogress", "in_progress", "break",
     "penaltyshootout", "in progress"].includes(s);
}

function publicGame(g) {
  return {
    gameId: String(g.gameId || ""),
    slug: String(g.slug || ""),
    sport: g.sport,
    league: String(g.leagueAbbreviation || g.league || ""),
    homeTeam: String(g.homeTeam || ""),
    awayTeam: String(g.awayTeam || ""),
    title: String(g.title || ""),
    startDate: g.startDate || g.start_date || null,
    status: String(g.status || ""),
    score: String(g.score || ""),
    period: String(g.period || ""),
    elapsed: String(g.elapsed || ""),
    live: true,
    ended: false,
    lastUpdate: g.lastUpdate || new Date().toISOString()
  };
}

async function gammaEvents(sport) {
  const tag = sport === "football" ? "soccer" : sport;

  const url = new URL(
    "https://gamma-api.polymarket.com/events"
  );

  url.searchParams.set("active", "true");
  url.searchParams.set("closed", "false");
  url.searchParams.set("limit", "100");
  url.searchParams.set("offset", "0");
  url.searchParams.set("tag_slug", tag);
  url.searchParams.set("include_tag", "true");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);

  try {
    const r = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" }
    });

    if (!r.ok) return [];

    const data = await r.json();
    return Array.isArray(data) ? data : [];

  } catch (e) {
    console.error("Gamma error", sport, e.message);
    return [];

  } finally {
    clearTimeout(timer);
  }
}

function normalizeEvent(e, sport) {
  const markets = (
    Array.isArray(e.markets) ? e.markets : []
  ).map(m => ({
    id: String(m.id || ""),
    question: String(
      m.question || m.groupItemTitle || m.title || "Match Winner"
    ),
    conditionId: String(m.conditionId || m.condition_id || ""),
    outcomes: parseArray(m.outcomes),
    clobTokenIds: parseArray(
      m.clobTokenIds || m.clob_token_ids
    )
  })).filter(m => m.clobTokenIds.some(validToken));

  if (!markets.length) return null;

  return {
    id: String(e.id || e.slug || ""),
    slug: String(e.slug || ""),
    title: String(e.title || e.question || e.slug || "Match"),
    sport,
    startDate: e.startDate || e.start_date || null,
    endDate: e.endDate || e.end_date || null,
    volume: Number(e.volume || 0),
    markets
  };
}

function eventMatchesGame(e, g) {
  const a = String(e.slug || "").toLowerCase();
  const b = String(g.slug || "").toLowerCase();

  if (a && b && a === b) return true;

  const text = `${e.title || ""} ${e.slug || ""}`.toLowerCase();

  const teams = [
    g.homeTeam,
    g.awayTeam
  ].map(x => String(x || "").toLowerCase())
   .filter(x => x.length > 1);

  return teams.length === 2 &&
    teams.every(t => text.includes(t));
}

function tokensForEvent(e) {
  const out = [];

  for (const m of e.markets || []) {
    m.clobTokenIds.forEach((id, i) => {
      if (!validToken(id)) return;

      out.push({
        id: String(id),
        outcome: String(m.outcomes[i] || `Outcome ${i + 1}`),
        market: m.question,
        marketId: m.conditionId || m.id,
        eventId: e.id,
        eventSlug: e.slug
      });
    });
  }

  return out;
}

function subscribeClob(ids, initial = false) {
  if (!clob || clob.readyState !== WebSocket.OPEN) return;

  for (const batch of chunks(ids, 100)) {
    if (!batch.length) continue;

    send(clob, initial
      ? {
          type: "market",
          assets_ids: batch,
          custom_feature_enabled: true
        }
      : {
          operation: "subscribe",
          assets_ids: batch,
          custom_feature_enabled: true
        }
    );
  }
}

function addTokens(ids) {
  const added = [];

  for (const id of ids) {
    const t = String(id);

    if (
      !validToken(t) ||
      tokens.has(t) ||
      tokens.size >= MAX_TOKENS
    ) continue;

    tokens.add(t);
    added.push(t);
  }

  if (added.length) subscribeClob(added);

  return added.length;
}

async function discoverLiveEvents() {
  if (discoveryBusy) return;

  discoveryBusy = true;

  try {
    const sportsSet = new Set(
      [...liveGames.values()].map(g => g.sport)
    );

    for (const sport of sportsSet) {
      const rows = await gammaEvents(sport);

      for (const raw of rows) {
        const e = normalizeEvent(raw, sport);
        if (!e) continue;

        for (const g of liveGames.values()) {
          if (
            g.sport === sport &&
            eventMatchesGame(e, g)
          ) {
            g.event = e;

            addTokens(
              tokensForEvent(e).map(t => t.id)
            );
          }
        }
      }
    }

    broadcast({
      type: "live_matches",
      matches: [...liveGames.values()].map(publicGame),
      receivedAt: Date.now()
    });

  } catch (e) {
    console.error("Discovery error:", e.message);

  } finally {
    discoveryBusy = false;
  }
}

function handleSportsMessage(raw) {
  if (raw === "ping") {
    if (sports && sports.readyState === WebSocket.OPEN) {
      sports.send("pong");
    }
    return;
  }

  let data;

  try {
    data = JSON.parse(raw);
  } catch {
    return;
  }

  for (const g of (Array.isArray(data) ? data : [data])) {
    if (!g || typeof g !== "object") continue;

    const sport = sportFromLeague(
      g.leagueAbbreviation || g.sport || g.league
    );

    const key = String(
      g.slug || g.gameId || ""
    ).toLowerCase();

    if (!key || !sport || isEnded(g) || !isLive(g)) {
      if (key && liveGames.has(key) && isEnded(g)) {
        liveGames.delete(key);

        broadcast({
          type: "match_ended",
          slug: key,
          gameId: String(g.gameId || "")
        });
      }

      continue;
    }

    liveGames.set(key, {
      ...(liveGames.get(key) || {}),
      ...g,
      sport,
      live: true,
      ended: false
    });
  }

  broadcast({
    type: "live_matches",
    matches: [...liveGames.values()].map(publicGame),
    receivedAt: Date.now()
  });

  clearTimeout(discoveryTimer);
  discoveryTimer = setTimeout(discoverLiveEvents, 300);
}

function connectSports() {
  try {
    sports?.terminate();
  } catch {}

  sports = new WebSocket(SPORTS_WS, {
    handshakeTimeout: 10000
  });

  sports.on("open", () => {
    sportsConnected = true;
    retrySports = 1000;

    broadcast({
      type: "sports_status",
      connected: true
    });

    console.log("Sports feed connected");
  });

  sports.on("message", d => {
    sportsPackets++;
    lastSportsPacket = Date.now();
    handleSportsMessage(d.toString());
  });

  sports.on("error", e => {
    console.error("Sports WS:", e.message);
  });

  sports.on("close", () => {
    sportsConnected = false;

    broadcast({
      type: "sports_status",
      connected: false
    });

    const wait = retrySports;
    retrySports = Math.min(retrySports * 2, 30000);

    setTimeout(connectSports, wait);
  });
}

function bestPrice(levels, side) {
  if (!Array.isArray(levels)) return null;

  const p = levels
    .map(x => Number(x.price))
    .filter(x =>
      Number.isFinite(x) &&
      x > 0 &&
      x < 1
    );

  if (!p.length) return null;

  return side === "bid"
    ? Math.max(...p)
    : Math.min(...p);
}

function emitBook(id, bid, ask, at) {
  quoteBooks.set(id, {
    bestBid: bid,
    bestAsk: ask,
    receivedAt: at
  });

  broadcast({
    type: "clob_quote",
    asset_id: id,
    best_bid: bid,
    best_ask: ask,
    receivedAt: at,
    source: "vps_clob"
  });
}

function handleClobMessage(raw) {
  let data;

  try {
    data = JSON.parse(raw);
  } catch {
    return;
  }

  for (const m of (Array.isArray(data) ? data : [data])) {
    if (!m || typeof m !== "object") continue;

    const at = Date.now();

    const id = String(
      m.asset_id || m.assetId || m.token_id || ""
    );

    if (
      m.event_type === "price_change" &&
      Array.isArray(m.price_changes)
    ) {
      for (const c of m.price_changes) {
        const t = String(c.asset_id || "");
        if (!validToken(t)) continue;

        const old = quoteBooks.get(t) || {};
        const b = Number(c.best_bid);
        const a = Number(c.best_ask);

        emitBook(
          t,
          Number.isFinite(b) && b > 0
            ? b
            : old.bestBid ?? null,
          Number.isFinite(a) && a > 0
            ? a
            : old.bestAsk ?? null,
          at
        );
      }

      continue;
    }

    if (!validToken(id)) continue;

    if (
      m.event_type === "book" ||
      (Array.isArray(m.bids) && Array.isArray(m.asks))
    ) {
      emitBook(
        id,
        bestPrice(m.bids, "bid"),
        bestPrice(m.asks, "ask"),
        at
      );

    } else if (
      m.event_type === "best_bid_ask" ||
      m.best_bid !== undefined ||
      m.best_ask !== undefined
    ) {
      const b = Number(m.best_bid);
      const a = Number(m.best_ask);

      emitBook(
        id,
        Number.isFinite(b) && b > 0 ? b : null,
        Number.isFinite(a) && a > 0 ? a : null,
        at
      );
    }
  }
}

function connectClob() {
  try {
    clob?.terminate();
  } catch {}

  clob = new WebSocket(CLOB_WS, {
    handshakeTimeout: 10000
  });

  clob.on("open", () => {
    clobConnected = true;
    retryClob = 1000;

    subscribeClob([...tokens], true);

    broadcast({
      type: "clob_status",
      connected: true
    });

    console.log("CLOB connected");
  });

  clob.on("message", d => {
    clobPackets++;
    lastClobPacket = Date.now();
    handleClobMessage(d.toString());
  });

  clob.on("error", e => {
    console.error("CLOB WS:", e.message);
  });

  clob.on("close", () => {
    clobConnected = false;

    broadcast({
      type: "clob_status",
      connected: false
    });

    const wait = retryClob;
    retryClob = Math.min(retryClob * 2, 30000);

    setTimeout(connectClob, wait);
  });
}

function websiteMessage(msg) {
  const p = msg.payload || msg;

  const token = String(
    p.tokenId || p.asset_id || p.token_id || ""
  );

  const price = Number(p.price);
  const side = String(p.side || "").toUpperCase();

  if (
    !validToken(token) ||
    !Number.isFinite(price) ||
    price <= 0 ||
    price >= 1 ||
    !["BUY", "SELL"].includes(side)
  ) return;

  websitePackets++;
  lastWebsitePacket = Date.now();

  broadcast({
    type: "website_update",
    source: "polymarket_website",
    payload: {
      tokenId: token,
      price,
      side,
      priceCents: price * 100,
      decimalOdds: 1 / price,
      observedAtMs: Number(p.observedAtMs || Date.now()),
      receivedAt: Date.now(),
      outcome: p.outcome || ""
    }
  });
}

function clientMessage(ws, raw) {
  let m;

  try {
    m = JSON.parse(raw.toString());
  } catch {
    return;
  }

  if (m.type === "hello") {
    if (m.role === "dashboard") {
      ws.role = "dashboard";
      dashboards.add(ws);

      send(ws, {
        type: "bridge_status",
        clobConnected,
        sportsConnected,
        tokens: tokens.size,
        clobPackets,
        sportsPackets,
        websitePackets
      });

      send(ws, {
        type: "live_matches",
        matches: [...liveGames.values()].map(publicGame),
        receivedAt: Date.now()
      });

      for (const [id, q] of quoteBooks) {
        send(ws, {
          type: "clob_quote",
          asset_id: id,
          best_bid: q.bestBid,
          best_ask: q.bestAsk,
          receivedAt: q.receivedAt
        });
      }

    } else if (m.role === "website") {
      ws.role = "website";
      websites.add(ws);

      send(ws, {
        type: "website_connected",
        receivedAt: Date.now()
      });

    } else {
      ws.close(1008, "Unknown role");
    }

    return;
  }

  if (ws.role === "dashboard" && m.type === "subscribe") {
    const ids = Array.isArray(m.assets_ids)
      ? m.assets_ids
      : [];

    const added = addTokens(ids);

    send(ws, {
      type: "subscription_received",
      count: added,
      total: tokens.size
    });

  } else if (ws.role === "dashboard" && m.type === "refresh") {
    discoverLiveEvents();

    send(ws, {
      type: "refresh_ack",
      at: Date.now()
    });

  } else if (ws.role === "dashboard" && m.type === "ping") {
    send(ws, {
      type: "pong",
      at: Date.now()
    });

  } else if (
    ws.role === "website" &&
    ["website_quote", "website_update"].includes(m.type)
  ) {
    websiteMessage(m);
  }
}

function json(res, code, obj) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });

  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  const url = new URL(
    req.url,
    `http://${req.headers.host || "localhost"}`
  );

  if (url.pathname === "/health") {
    return json(res, 200, {
      ok: true,
      service: "crystal-bridge",
      clobConnected,
      sportsConnected,
      liveMatches: liveGames.size,
      tokens: tokens.size,
      clobPackets,
      sportsPackets,
      websitePackets,
      lastClobPacket,
      lastSportsPacket,
      lastWebsitePacket,
      timeAmsterdam: new Date().toLocaleString(
        "en-GB",
        { timeZone: "Europe/Amsterdam" }
      ),
      timeUTC: Date.now()
    });
  }

  if (
    url.pathname === "/" ||
    url.pathname === "/index.html"
  ) {
    fs.readFile(INDEX, (err, data) => {
      if (err) {
        return json(res, 500, {
          ok: false,
          error: "Dashboard file missing",
          path: INDEX
        });
      }

      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store"
      });

      res.end(data);
    });

    return;
  }

  json(res, 404, {
    ok: false,
    error: "Not found"
  });
});

const wss = new WebSocket.Server({
  noServer: true,
  perMessageDeflate: false,
  maxPayload: MAX_MESSAGE
});

server.on("upgrade", (req, socket, head) => {
  const url = new URL(
    req.url,
    `http://${req.headers.host || "localhost"}`
  );

  const origin = req.headers.origin || "";

  if (
    url.pathname !== "/ws" ||
    !ALLOWED_ORIGINS.has(origin) ||
    !BRIDGE_KEY ||
    url.searchParams.get("key") !== BRIDGE_KEY ||
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

wss.on("connection", ws => {
  clients.add(ws);

  const timer = setTimeout(() => {
    if (!ws.role) ws.close(1008, "Send hello first");
  }, 5000);

  ws.on("message", d => {
    clearTimeout(timer);
    clientMessage(ws, d);
  });

  ws.on("close", () => {
    clearTimeout(timer);
    clients.delete(ws);
    dashboards.delete(ws);
    websites.delete(ws);
  });

  ws.on("error", () => {
    clients.delete(ws);
    dashboards.delete(ws);
    websites.delete(ws);
  });
});

server.listen(PORT, HOST, () => {
  console.log(
    `Crystal Bridge + dashboard listening on [::]:${PORT}`
  );

  if (!BRIDGE_KEY) {
    console.error(
      "WARNING: BRIDGE_TOKEN is empty; WebSocket authentication will reject clients."
    );
  }

  connectClob();
  connectSports();
});

process.on("SIGTERM", () => {
  try { clob?.close(); } catch {}
  try { sports?.close(); } catch {}

  for (const ws of clients) {
    try { ws.close(); } catch {}
  }

  server.close(() => process.exit(0));
});