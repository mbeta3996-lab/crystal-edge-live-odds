
const GAMMA = "https://gamma-api.polymarket.com";
const CLOB_WS = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

let socket = null;
let matches = [];
let tokenMap = new Map();
let books = new Map();
let reconnectTimer = null;
let stopped = false;

const send = (type, data = {}) =>
  self.postMessage({ type, ...data });

const arr = value => {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const clean = value =>
  String(value || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

function sportOf(event) {
  const s = [
    event.sport,
    event.category,
    event.slug,
    event.title,
    event.description,
    ...(event.tags || []).map(t => typeof t === "string" ? t : t.label || t.slug || "")
  ].join(" ").toLowerCase();

  if (/cricket|ipl|t20|odi|test-match|ashes/.test(s)) return "cricket";
  if (/tennis|atp-|wta-|grand-slam/.test(s)) return "tennis";
  if (/basketball|nba|wnba|euroleague/.test(s)) return "basketball";
  if (/soccer|football|premier-league|champions-league|la-liga|serie-a|bundesliga|mls/.test(s)) return "football";
  return "";
}

function matchupOf(title) {
  const t = clean(title);
  if (!t || /\b(toss|most sixes|most fours|top scorer|player of the match|ballon d'or|champion|outright|election|bitcoin|ethereum|s&p 500)\b/i.test(t)) return null;

  const parts = t.split(/\s+(?:vs\.?|versus|v\.)\s+/i);
  if (parts.length < 2) return null;

  const a = parts[parts.length - 2].replace(/^[\s:—-]+|[\s:—-]+$/g, "");
  const b = parts[parts.length - 1].replace(/^[\s:—-]+|[\s:—-]+$/g, "");
  const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, "");

  if (!a || !b || norm(a) === norm(b)) return null;
  return { home: a, away: b };
}

function isWinnerMarket(market, sport) {
  const q = clean(market.question || market.groupItemTitle || "").toLowerCase();

  if (!q) return false;
  if (/\b(toss|most sixes|most fours|top scorer|player of the match|match double|double chance|correct score|total runs|total goals|total points|over\/under|handicap|spread|to qualify|set betting|exact score|first innings|first goal|corners|cards)\b/i.test(q)) return false;

  if (/\b(draw|tie)\b/i.test(q)) return sport === "football" && /\b(win|winner|draw)\b/i.test(q);

  return /\b(winner|win|to win|moneyline|match result|match winner)\b/i.test(q);
}

function parseEvent(event) {
  if (event.closed === true || event.active === false) return [];
  const sport = sportOf(event);
  if (!sport) return [];

  const matchup = matchupOf(event.title);
  if (!matchup) return [];

  const markets = Array.isArray(event.markets) ? event.markets : [];
  const output = [];

  for (const m of markets) {
    if (m.closed === true || m.active === false || !isWinnerMarket(m, sport)) continue;

    const outcomes = arr(m.outcomes);
    const ids = arr(m.clobTokenIds);
    if (outcomes.length < 2 || ids.length < 2 || outcomes.length !== ids.length) continue;

    const selections = outcomes.map((name, i) => ({
      name: clean(name),
      tokenId: String(ids[i] || "")
    })).filter(x => x.name && x.tokenId);

    if (selections.length < 2) continue;

    const id = String(m.id || m.conditionId || `${event.id}-${output.length}`);
    output.push({
      id,
      eventId: String(event.id || ""),
      title: clean(event.title),
      home: matchup.home,
      away: matchup.away,
      sport,
      startTime: event.startTime || event.startDate || event.gameStartTime || null,
      url: event.slug ? `https://polymarket.com/event/${event.slug}` : "",
      question: clean(m.question || m.groupItemTitle || event.title),
      marketId: id,
      selections,
      quotes: {}
    });
  }
  return output;
}

function validPrice(value) {
  const p = Number(value);
  return Number.isFinite(p) && p > 0 && p < 1 ? p : null;
}

function decimal(value) {
  const p = validPrice(value);
  return p === null ? null : Number((1 / p).toFixed(2));
}

function publish() {
  send("matches", { matches });
}

function updateBook(token, bids, asks) {
  const bid = bids.length ? Math.max(...bids.map(x => Number(x.price)).filter(Number.isFinite)) : null;
  const ask = asks.length ? Math.min(...asks.map(x => Number(x.price)).filter(Number.isFinite)) : null;

  books.set(token, { bid: validPrice(bid), ask: validPrice(ask), updatedAt: Date.now() });

  const linked = tokenMap.get(token);
  if (!linked) return;

  const match = matches.find(m => m.id === linked.marketId);
  if (!match) return;

  match.quotes[linked.name] = {
    buy: decimal(ask),
    sell: decimal(bid),
    bid: validPrice(bid),
    ask: validPrice(ask),
    updatedAt: Date.now()
  };

  send("quote", {
    marketId: match.id,
    tokenId: token,
    outcome: linked.name,
    quote: match.quotes[linked.name]
  });
}

function handleSocketMessage(raw) {
  let data;
  try { data = JSON.parse(raw); } catch { return; }

  const events = Array.isArray(data) ? data : [data];

  for (const event of events) {
    if (event.event_type === "book" && event.asset_id) {
      updateBook(
        String(event.asset_id),
        Array.isArray(event.bids) ? event.bids : [],
        Array.isArray(event.asks) ? event.asks : []
      );
    }

    if (event.event_type === "price_change" && Array.isArray(event.price_changes)) {
      for (const change of event.price_changes) {
        const token = String(change.asset_id || "");
        if (!token) continue;

        const old = books.get(token) || {};
        const bid = validPrice(change.best_bid) ?? old.bid ?? null;
        const ask = validPrice(change.best_ask) ?? old.ask ?? null;
        books.set(token, { bid, ask, updatedAt: Date.now() });

        const linked = tokenMap.get(token);
        if (!linked) continue;
        const match = matches.find(m => m.id === linked.marketId);
        if (!match) continue;

        match.quotes[linked.name] = {
          buy: decimal(ask),
          sell: decimal(bid),
          bid,
          ask,
          updatedAt: Date.now()
        };

        send("quote", {
          marketId: match.id,
          tokenId: token,
          outcome: linked.name,
          quote: match.quotes[linked.name]
        });
      }
    }
  }
}

function connectSocket() {
  if (stopped || tokenMap.size === 0) return;
  try {
    if (socket) socket.close();
    socket = new WebSocket(CLOB_WS);

    socket.onopen = () => {
      send("status", { status: "LIVE", message: "CLOB connected" });
      const tokens = [...tokenMap.keys()];
      for (let i = 0; i < tokens.length; i += 500) {
        socket.send(JSON.stringify({
          type: "market",
          assets_ids: tokens.slice(i, i + 500),
          custom_feature_enabled: true
        }));
      }
    };

    socket.onmessage = e => handleSocketMessage(e.data);

    socket.onerror = () =>
      send("status", { status: "DISCONNECTED", message: "WebSocket error" });

    socket.onclose = () => {
      send("status", { status: "WAITING", message: "Reconnecting…" });
      if (!stopped) {
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connectSocket, 2000);
      }
    };
  } catch (error) {
    send("status", { status: "DISCONNECTED", message: String(error) });
  }
}

async function loadMatches() {
  stopped = false;
  send("status", { status: "WAITING", message: "Loading Polymarket events…" });

  try {
    const found = [];
    const seen = new Set();

    for (let offset = 0; offset < 1000; offset += 100) {
      const url = new URL(`${GAMMA}/events`);
      url.searchParams.set("active", "true");
      url.searchParams.set("closed", "false");
      url.searchParams.set("limit", "100");
      url.searchParams.set("offset", String(offset));
      url.searchParams.set("order", "startDate");
      url.searchParams.set("ascending", "true");

      const response = await fetch(url.toString());
      if (!response.ok) throw new Error(`Gamma HTTP ${response.status}`);

      const page = await response.json();
      if (!Array.isArray(page) || page.length === 0) break;

      for (const event of page) {
        const rows = parseEvent(event);
        for (const row of rows) {
          if (seen.has(row.id)) continue;
          seen.add(row.id);
          found.push(row);
        }
      }

      send("stats", { eventsLoaded: offset + page.length, matchesFound: found.length });
      if (page.length < 100) break;
    }

    matches = found;
    tokenMap.clear();
    books.clear();

    for (const match of matches) {
      for (const selection of match.selections) {
        tokenMap.set(selection.tokenId, {
          marketId: match.id,
          name: selection.name
        });
      }
    }

    publish();
    send("stats", {
      eventsLoaded: matches.length,
      matchesFound: matches.length,
      tokensSubscribed: tokenMap.size
    });

    if (tokenMap.size) connectSocket();
    else send("status", { status: "WAITING", message: "No eligible outcome tokens found" });
  } catch (error) {
    send("status", { status: "DISCONNECTED", message: String(error?.message || error) });
    send("error", { message: String(error?.message || error) });
  }
}

self.onmessage = event => {
  const data = event.data || {};
  if (data.type === "start" || data.type === "refresh") {
    loadMatches();
  } else if (data.type === "stop") {
    stopped = true;
    clearTimeout(reconnectTimer);
    if (socket) socket.close();
  }
};

loadMatches();

