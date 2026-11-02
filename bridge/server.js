"use strict";

const http = require("http");
const WebSocket = require("ws");

const PORT = Number(process.env.PORT || 8787);
const HOST = "127.0.0.1";

const GAMMA = "https://gamma-api.polymarket.com";
const CLOB_WS = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const SPORTS_WS = "wss://sports-api.polymarket.com/ws";

const MAX_CLIENTS = 10;
const MAX_TOKENS = 500;
const MAX_MESSAGE = 65536;
const BRIDGE_KEY = process.env.BRIDGE_TOKEN || "";

const ALLOWED_ORIGINS = new Set([
  "https://mbeta3996-lab.github.io",
  "https://polymarket.com",
  "https://www.polymarket.com"
]);

const ALLOWED_SPORTS = new Set(["cricket", "tennis", "football"]);

const clients = new Set();
const dashboardClients = new Set();
const websiteClients = new Set();
const tokens = new Set();

const liveGames = new Map();
const eventCache = new Map();
const quoteBooks = new Map();

let clob = null;
let sports = null;
let clobConnected = false;
let sportsConnected = false;
let clobPackets = 0;
let sportsPackets = 0;
let websitePackets = 0;
let lastClobPacket = null;
let lastSportsPacket = null;
let lastWebsitePacket = null;
let retryClob = 1000;
let retrySports = 1000;
let discoveryBusy = false;
let discoveryTimer = null;

function send(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(data)); } catch {}
  }
}

function broadcast(data) {
  for (const ws of dashboardClients) send(ws, data);
}

function validToken(v) {
  return /^\d{10,}$/.test(String(v || ""));
}

function chunks(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
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

function normalizeSportStatus(game) {
  const status = String(game.status || "").toLowerCase();
  const live = game.live === true ||
    ["inprogress", "in_progress", "inprogress", "break", "penaltyshootout", "in progress"].includes(status);

  const ended = game.ended === true ||
    ["final", "finished", "ended", "ft", "ft ot", "ft nr", "awarded", "cancelled", "canceled"].includes(status);

  return { live: live && !ended, ended };
}

function gameKey(g) {
  return String(g.slug || g.gameId || "").toLowerCase();
}

function publicGame(g) {
  return {
    gameId: String(g.gameId || ""),
    slug: String(g.slug || ""),
    sport: g.sport,
    league: String(g.leagueAbbreviation || ""),
    homeTeam: String(g.homeTeam || ""),
    awayTeam: String(g.awayTeam || ""),
    status: String(g.status || ""),
    score: String(g.score || ""),
    period: String(g.period || ""),
    elapsed: String(g.elapsed || ""),
    live: true,
    ended: false,
    lastUpdate: g.lastUpdate || new Date().toISOString(),
    event: g.event || null
  };
}

async function gammaEvents(sport) {
  const tagCandidates = {
    cricket: ["cricket"],
    tennis: ["tennis"],
    football: ["soccer"]
  }[sport];

  const found = [];

  for (const tag of tagCandidates) {
    const url = new URL(`${GAMMA}/events`);
    url.searchParams.set("active", "true");
    url.searchParams.set("closed", "false");
    url.searchParams.set("limit", "100");
    url.searchParams.set("offset", "0");
    url.searchParams.set("tag_slug", tag);
    url.searchParams.set("include_tag", "true");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { accept: "application/json" }
      });

      if (!response.ok) continue;

      const data = await response.json();
      if (Array.isArray(data)) found.push(...data);
    } catch (e) {
      console.error("Gamma discovery error:", sport, tag, e.message);
    } finally {
      clearTimeout(timer);
    }
  }

  return found;
}

function normalizeEvent(event, sport) {
  const markets = Array.isArray(event.markets) ? event.markets : [];

  const normalizedMarkets = markets.map(m => ({
    id: String(m.id || ""),
    question: String(m.question || m.groupItemTitle || m.title || ""),
    conditionId: String(m.conditionId || m.condition_id || ""),
    outcomes: parseArray(m.outcomes),
    clobTokenIds: parseArray(m.clobTokenIds || m.clob_token_ids)
  })).filter(m => m.clobTokenIds.some(validToken));

  if (!normalizedMarkets.length) return null;

  return {
    id: String(event.id || event.slug || ""),
    slug: String(event.slug || ""),
    title: String(event.title || event.question || event.slug || "Match"),
    sport,
    startDate: event.startDate || event.start_date || null,
    endDate: event.endDate || event.end_date || null,
    volume: Number(event.volume || 0),
    markets: normalizedMarkets
  };
}

function eventMatchesGame(event, game) {
  const eSlug = String(event.slug || "").toLowerCase();
  const gSlug = String(game.slug || "").toLowerCase();

  if (eSlug && gSlug && eSlug === gSlug) return true;

  const eventText = `${event.title || ""} ${event.slug || ""}`.toLowerCase();
  const teams = [game.homeTeam, game.awayTeam]
    .map(x => String(x || "").toLowerCase())
    .filter(x => x.length > 1);

  if (teams.length !== 2) return false;

  return teams.every(team => eventText.includes(team));
}

function tokensForEvent(event) {
  const out = [];

  for (const market of event.markets || []) {
    market.clobTokenIds.forEach((id, i) => {
      const token = String(id || "");
      if (!validToken(token)) return;

      out.push({
        id: token,
        outcome: String(market.outcomes[i] || `Outcome ${i + 1}`),
        market: market.question,
        marketId: market.conditionId || market.id,
        eventId: event.id,
        eventSlug: event.slug
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
      ? { type: "market", assets_ids: batch, custom_feature_enabled: true }
      : { operation: "subscribe", assets_ids: batch, custom_feature_enabled: true }
    );
  }
}

function subscribeEventTokens(event) {
  const added = [];

  for (const token of tokensForEvent(event)) {
    if (!validToken(token.id)) continue;

    if (!tokens.has(token.id) && tokens.size < MAX_TOKENS) {
      tokens.add(token.id);
      added.push(token.id);
    }
  }

  if (added.length) subscribeClob(added, false);

  return added.length;
}

async function attachEventsToLiveGames() {
  if (discoveryBusy) return;
  discoveryBusy = true;

  try {
    const sportsToScan = new Set(
      [...liveGames.values()].map(g => g.sport).filter(Boolean)
    );

    if (!sportsToScan.size) {
      broadcast({ type: "live_matches", matches: [] });
      return;
    }

    for (const sport of sportsToScan) {
      const events = await gammaEvents(sport);

      for (const raw of events) {
        const event = normalizeEvent(raw, sport);
        if (!event) continue;

        eventCache.set(event.id, event);

        for (const [key, game] of liveGames) {
          if (game.sport !== sport) continue;

          if (eventMatchesGame(event, game)) {
            game.event = event;
            game.eventId = event.id;
            game.eventSlug = event.slug;
            subscribeEventTokens(event);
            liveGames.set(key, game);
          }
        }
      }
    }

    broadcast({
      type: "live_matches",
      matches: [...liveGames.values()].map(publicGame),
      tokens: tokens.size,
      receivedAt: Date.now()
    });
  } catch (e) {
    console.error("Live event mapping error:", e.message);
  } finally {
    discoveryBusy = false;
  }
}

function handleSportsMessage(raw) {
  if (raw === "ping") {
    if (sports && sports.readyState === WebSocket.OPEN) sports.send("pong");
    return;
  }

  let data;
  try { data = typeof raw === "string" ? JSON.parse(raw) : raw; }
  catch { return; }

  const rows = Array.isArray(data) ? data : [data];

  for (const g of rows) {
    if (!g || typeof g !== "object") continue;

    const sport = sportFromLeague(g.leagueAbbreviation || g.sport || g.league);
    const { live, ended } = normalizeSportStatus(g);
    const key = gameKey(g);

    if (!key || !sport || !ALLOWED_SPORTS.has(sport)) continue;

    if (ended || !live) {
      if (liveGames.has(key)) {
        liveGames.delete(key);
        broadcast({ type: "match_ended", slug: key, gameId: String(g.gameId || "") });
      }
      continue;
    }

    const old = liveGames.get(key) || {};

    liveGames.set(key, {
      ...old,
      ...g,
      sport,
      slug: String(g.slug || old.slug || ""),
      gameId: String(g.gameId || old.gameId || ""),
      live: true,
      ended: false,
      lastUpdate: g.lastUpdate || new Date().toISOString()
    });
  }

  broadcast({
    type: "live_matches",
    matches: [...liveGames.values()].map(publicGame),
    receivedAt: Date.now()
  });

  clearTimeout(discoveryTimer);
  discoveryTimer = setTimeout(attachEventsToLiveGames, 250);
}

function connectSports() {
  if (sports) {
    try { sports.terminate(); } catch {}
  }

  sports = new WebSocket(SPORTS_WS, { handshakeTimeout: 10000 });

  sports.on("open", () => {
    sportsConnected = true;
    retrySports = 1000;
    broadcast({ type: "sports_status", connected: true });
    console.log("Sports WebSocket connected");
  });

  sports.on("message", data => {
    sportsPackets++;
    lastSportsPacket = Date.now();
    handleSportsMessage(data.toString());
  });

  sports.on("error", e => console.error("Sports WS:", e.message));

  sports.on("close", () => {
    sportsConnected = false;
    broadcast({ type: "sports_status", connected: false });
    const wait = retrySports;
    retrySports = Math.min(retrySports * 2, 30000);
    setTimeout(connectSports, wait);
  });
}

function bestPrice(levels, side) {
  if (!Array.isArray(levels) || !levels.length) return null;

  const prices = levels.map(x => Number(x.price)).filter(x => Number.isFinite(x) && x > 0 && x < 1);
  if (!prices.length) return null;

  return side === "bid" ? Math.max(...prices) : Math.min(...prices);
}

function emitBook(token, bid, ask, receivedAt) {
  quoteBooks.set(token, { bestBid: bid, bestAsk: ask, receivedAt });

  broadcast({
    type: "clob_quote",
    asset_id: token,
    best_bid: bid,
    best_ask: ask,
    receivedAt,
    source: "vps_clob"
  });
}

function handleClobMessage(raw) {
  let data;
  try { data = JSON.parse(raw); } catch { return; }

  const rows = Array.isArray(data) ? data : [data];

  for (const msg of rows) {
    if (!msg || typeof msg !== "object") continue;

    const token = String(msg.asset_id || msg.assetId || msg.token_id || "");
    if (!validToken(token)) continue;

    const receivedAt = Date.now();

    if (msg.event_type === "book" || (Array.isArray(msg.bids) && Array.isArray(msg.asks))) {
      const bid = bestPrice(msg.bids, "bid");
      const ask = bestPrice(msg.asks, "ask");
      emitBook(token, bid, ask, receivedAt);
      continue;
    }

    if (msg.event_type === "best_bid_ask" || msg.best_bid !== undefined || msg.best_ask !== undefined) {
      const bid = Number(msg.best_bid);
      const ask = Number(msg.best_ask);

      emitBook(
        token,
        Number.isFinite(bid) && bid > 0 ? bid : null,
        Number.isFinite(ask) && ask > 0 ? ask : null,
        receivedAt
      );
      continue;
    }

    if (msg.event_type === "price_change" && Array.isArray(msg.price_changes)) {
      for (const change of msg.price_changes) {
        const id = String(change.asset_id || "");
        if (!validToken(id)) continue;

        const previous = quoteBooks.get(id) || {};
        const bid = Number(change.best_bid);
        const ask = Number(change.best_ask);

        emitBook(
          id,
          Number.isFinite(bid) && bid > 0 ? bid : previous.bestBid ?? null,
          Number.isFinite(ask) && ask > 0 ? ask : previous.bestAsk ?? null,
          receivedAt
        );
      }
    }
  }
}

function connectClob() {
  if (clob) {
    try { clob.terminate(); } catch {}
  }

  clob = new WebSocket(CLOB_WS, { handshakeTimeout: 10000 });

  clob.on("open", () => {
    clobConnected = true;
    retryClob = 1000;
    subscribeClob([...tokens], true);
    broadcast({ type: "clob_status", connected: true });
    console.log("CLOB WebSocket connected");
  });

  clob.on("message", data => {
    clobPackets++;
    lastClobPacket = Date.now();
    handleClobMessage(data.toString());
  });

  clob.on("error", e => console.error("CLOB WS:", e.message));

  clob.on("close", () => {
    clobConnected = false;
    broadcast({ type: "clob_status", connected: false });
    const wait = retryClob;
    retryClob = Math.min(retryClob * 2, 30000);
    setTimeout(connectClob, wait);
  });
}

function websiteMessage(msg) {
  const payload = msg.payload || msg;
  const token = String(payload.tokenId || payload.asset_id || payload.token_id || "");
  const price = Number(payload.price);
  const side = String(payload.side || "").toUpperCase();

  if (!validToken(token) || !Number.isFinite(price) || price <= 0 || price >= 1) return;
  if (!["BUY", "SELL"].includes(side)) return;

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
      observedAtMs: Number(payload.observedAtMs || Date.now()),
      receivedAt: Date.now(),
      outcome: payload.outcome || ""
    }
  });
}

function onClientMessage(ws, message) {
  let msg;
  try { msg = JSON.parse(message.toString()); } catch { return; }

  if (msg.type === "hello") {
    if (msg.role === "dashboard") {
      ws.role = "dashboard";
      dashboardClients.add(ws);

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
        matches: [...liveGames.values()].map(publicGame)
      });

      for (const [token, quote] of quoteBooks) {
        send(ws, {
          type: "clob_quote",
          asset_id: token,
          best_bid: quote.bestBid,
          best_ask: quote.bestAsk,
          receivedAt: quote.receivedAt,
          source: "vps_clob"
        });
      }
    } else if (msg.role === "website") {
      ws.role = "website";
      websiteClients.add(ws);
      send(ws, { type: "website_connected", receivedAt: Date.now() });
    } else {
      ws.close(1008, "Unknown role");
    }
    return;
  }

  if (ws.role === "dashboard" && msg.type === "subscribe") {
    const ids = Array.isArray(msg.assets_ids) ? msg.assets_ids : [];
    const added = [];

    for (const id of ids) {
      const token = String(id);
      if (!validToken(token) || tokens.has(token) || tokens.size >= MAX_TOKENS) continue;
      tokens.add(token);
      added.push(token);
    }

    if (added.length) subscribeClob(added, false);
    send(ws, { type: "subscription_received", count: added.length, total: tokens.size });
    return;
  }

  if (ws.role === "dashboard" && msg.type === "ping") {
    send(ws, { type: "pong", at: Date.now() });
    return;
  }

  if (ws.role === "website" &&
      (msg.type === "website_quote" || msg.type === "website_update")) {
    websiteMessage(msg);
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (url.pathname === "/health") {
    res.writeHead(200);
    res.end(JSON.stringify({
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
      timeAmsterdam: new Date().toLocaleString("en-GB", { timeZone: "Europe/Amsterdam" }),
      timeUTC: Date.now()
    }));
    return;
  }

  if (url.pathname === "/") {
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, service: "crystal-bridge" }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ ok: false, error: "Not found" }));
});

const wss = new WebSocket.Server({
  noServer: true,
  perMessageDeflate: false,
  maxPayload: MAX_MESSAGE
});

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const origin = req.headers.origin || "";

  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }

  if (!ALLOWED_ORIGINS.has(origin)) {
    socket.destroy();
    return;
  }

  if (!BRIDGE_KEY || url.searchParams.get("key") !== BRIDGE_KEY) {
    socket.destroy();
    return;
  }

  if (clients.size >= MAX_CLIENTS) {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
});

wss.on("connection", ws => {
  clients.add(ws);

  const helloTimer = setTimeout(() => {
    if (!ws.role) ws.close(1008, "Send hello first");
  }, 5000);

  ws.on("message", data => {
    clearTimeout(helloTimer);
    onClientMessage(ws, data);
  });

  ws.on("close", () => {
    clearTimeout(helloTimer);
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

server.listen(PORT, HOST, () => {
  console.log(`Crystal bridge listening on ${HOST}:${PORT}`);
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