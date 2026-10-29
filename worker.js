"use strict";

const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";
const ALLOWED = ["cricket", "tennis", "football"];
const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store"
};

function reply(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...HEADERS, "Content-Type": "application/json" }
  });
}

function arr(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const result = JSON.parse(value);
      return Array.isArray(result) ? result : [];
    } catch {}
  }
  return [];
}

function text(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map(text).join(" ");
  }
  if (typeof value === "object") {
    return [
      value.name, value.label, value.slug,
      value.title, value.value
    ].filter(Boolean).join(" ");
  }
  return String(value);
}

function slugDate(value) {
  const match = String(value || "").match(
    /(?:^|[-_])((?:202[5-9]|203\d)-\d{2}-\d{2})(?:$|[-_])/
  );
  if (!match) return null;
  const date = new Date(match[1] + "T12:00:00Z");
  return Number.isNaN(date.getTime()) ? null : date;
}

function scheduledDate(event) {
  const fromSlug = slugDate(event.slug);
  if (fromSlug) return fromSlug;

  const explicit = [
    event.scheduledStartTime,
    event.startTime,
    event.gameStartTime,
    event.matchStartTime
  ].find(v => v && !Number.isNaN(Date.parse(v)));

  if (explicit) return new Date(explicit);

  // startDate can be an event creation date, so don't use it
  // when the slug already supplies the fixture date.
  const fallback = event.startDate || event.endDate;
  if (fallback && !Number.isNaN(Date.parse(fallback))) {
    return new Date(fallback);
  }
  return null;
}

function sportOf(event) {
  const all = [
    event.title, event.slug, event.sport,
    event.category, event.series,
    ...arr(event.tags).map(text),
    ...arr(event.markets).map(m =>
      [m.question, m.groupItemTitle, m.slug].join(" ")
    )
  ].join(" ").toLowerCase();

  if (/\b(cricket|t20|odi|test match|ipl|ashes|wicket)\b/.test(all)) {
    return "cricket";
  }

  if (/\b(tennis|atp|wta|challenger|grand slam|us open|wimbledon|roland garros|australian open)\b/.test(all)) {
    return "tennis";
  }

  if (/\b(football|soccer|premier league|champions league|la liga|serie a|bundesliga|ligue 1|mls|epl|uefa|fifa|world cup|fc | vs\.? )\b/.test(all)) {
    return "football";
  }

  return null;
}

function explicitLive(event) {
  return event.live === true ||
    event.isLive === true ||
    event.inplay === true ||
    event.inPlay === true ||
    event.gameStatus === "live" ||
    event.status === "live";
}

function extractTeams(title) {
  const value = String(title || "")
    .replace(/^(Tennis|Football|Soccer|Cricket)\s*:\s*/i, "");

  const parts = value.split(/\s+vs\.?\s+|\s+v\s+/i);
  if (parts.length >= 2) {
    return [parts[0].trim(), parts.slice(1).join(" vs ").trim()];
  }
  return [];
}

function tokenId(value) {
  if (typeof value === "string" || typeof value === "number") {
    const s = String(value);
    return /^\d{1,100}$/.test(s) ? s : null;
  }
  if (value && typeof value === "object") {
    return tokenId(
      value.token_id || value.tokenId ||
      value.asset_id || value.assetId || value.id
    );
  }
  return null;
}

function marketTokens(market, teams) {
  const outcomes = arr(market.outcomes).map(text);
  const ids = arr(
    market.clobTokenIds || market.clob_token_ids ||
    market.tokenIds || market.tokens
  ).map(tokenId);

  const result = [];
  const question = String(market.question || market.title || "");
  const yesNo = outcomes.length === 2 &&
    outcomes.every(o => /^(yes|no)$/i.test(o));

  if (yesNo && ids.length >= 2 && teams.length === 2) {
    // For "Will TEAM win?" markets, use YES as that team's token.
    const questionLower = question.toLowerCase();
    const team = teams.find(t =>
      t && questionLower.includes(t.toLowerCase())
    );
    if (team) {
      const yesIndex = outcomes.findIndex(
        o => o.toLowerCase() === "yes"
      );
      const id = ids[yesIndex];
      if (id) result.push({
        id, label: team, team, conditionId: market.conditionId || null,
        question
      });
    }
  } else {
    for (let i = 0; i < Math.min(outcomes.length, ids.length); i++) {
      if (!ids[i]) continue;
      result.push({
        id: ids[i],
        label: outcomes[i] || `Outcome ${i + 1}`,
        team: outcomes[i] || null,
        conditionId: market.conditionId || null,
        question
      });
    }
  }

  return result;
}

function normalize(event) {
  const sport = sportOf(event);
  const teams = extractTeams(event.title);
  const markets = arr(event.markets);
  const tokens = [];
  const seen = new Set();

  for (const market of markets) {
    for (const token of marketTokens(market, teams)) {
      if (seen.has(token.id)) continue;
      seen.add(token.id);
      tokens.push(token);
    }
  }

  const date = scheduledDate(event);

  return {
    id: String(event.id || event.slug || ""),
    title: event.title || event.slug || "Polymarket event",
    slug: event.slug || "",
    sport,
    teams,
    scheduledAt: date ? date.toISOString() : null,
    live: explicitLive(event),
    active: event.active !== false,
    closed: event.closed === true,
    tokens,
    marketCount: markets.length,
    url: event.slug
      ? `https://polymarket.com/event/${event.slug}`
      : null
  };
}

async function getJson(url) {
  const response = await fetch(url, {
    headers: { Accept: "application/json" }
  });
  if (!response.ok) {
    throw new Error(`Upstream HTTP ${response.status}`);
  }
  return response.json();
}

async function fetchEvents() {
  const all = [];
  const seen = new Set();
  const pageSize = 100;
  const maxPages = 20;

  for (let page = 0; page < maxPages; page++) {
    const url = new URL(`${GAMMA}/events`);
    url.searchParams.set("active", "true");
    url.searchParams.set("closed", "false");
    url.searchParams.set("limit", String(pageSize));
    url.searchParams.set("offset", String(page * pageSize));
    url.searchParams.set("order", "endDate");
    url.searchParams.set("ascending", "true");

    const data = await getJson(url.toString());
    const items = Array.isArray(data) ? data :
      (Array.isArray(data.data) ? data.data : []);

    if (!items.length) break;

    for (const event of items) {
      const id = String(event.id || event.slug || "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      all.push(event);
    }

    if (items.length < pageSize ||
        data.has_more === false ||
        data.hasMore === false) break;
  }

  return all;
}

function istDateKey(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric", month: "2-digit", day: "2-digit"
  }).format(date);
}

function todayIST() {
  return istDateKey(new Date());
}

async function handle(request) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: HEADERS });
  }
  if (request.method !== "GET") {
    return reply({ success: false, error: "GET only" }, 405);
  }

  if (path === "/health") {
    return reply({
      success: true,
      status: "ok",
      worker: "crystal-live-odds",
      source: "Polymarket Gamma + public CLOB",
      allowedSports: ALLOWED,
      todayIST: todayIST(),
      endpoints: [
        "/health", "/sports",
        "/matches?sport=all&limit=100&offset=0",
        "/event?id=EVENT_ID",
        "/price?token_id=TOKEN_ID&side=BUY",
        "/book?token_id=TOKEN_ID"
      ]
    });
  }

  if (path === "/sports") {
    return reply({
      success: true,
      sports: ALLOWED.map(id => ({
        id,
        label: id[0].toUpperCase() + id.slice(1)
      }))
    });
  }

  if (path === "/price") {
    const id = url.searchParams.get("token_id") || "";
    const side = (url.searchParams.get("side") || "BUY").toUpperCase();
    if (!/^\d{1,100}$/.test(id) ||
        !["BUY", "SELL"].includes(side)) {
      return reply({ success: false, error: "Invalid token_id or side" }, 400);
    }

    const result = await getJson(
      `${CLOB}/price?token_id=${encodeURIComponent(id)}&side=${side}`
    );
    const price = Number(result.price);
    return reply({
      success: true, tokenId: id, side,
      price: Number.isFinite(price) ? price : null,
      cents: Number.isFinite(price) ? price * 100 : null,
      decimalOdds: Number.isFinite(price) && price > 0
        ? 1 / price : null,
      timestamp: new Date().toISOString()
    });
  }

  if (path === "/book") {
    const id = url.searchParams.get("token_id") || "";
    if (!/^\d{1,100}$/.test(id)) {
      return reply({ success: false, error: "Invalid token_id" }, 400);
    }
    const result = await getJson(
      `${CLOB}/book?token_id=${encodeURIComponent(id)}`
    );
    return reply({ success: true, tokenId: id, book: result });
  }

  if (path === "/event") {
    const id = url.searchParams.get("id") || "";
    if (!id) return reply({ success: false, error: "id required" }, 400);

    const events = await getJson(
      `${GAMMA}/events?id=${encodeURIComponent(id)}`
    );
    const event = Array.isArray(events) ? events[0] : events;
    if (!event) return reply({ success: false, error: "Not found" }, 404);
    return reply({ success: true, data: normalize(event), raw: event });
  }

  if (path === "/matches") {
    const sportArg = (url.searchParams.get("sport") || "all").toLowerCase();
    const day = (url.searchParams.get("day") || "").toLowerCase();
    const liveOnly = url.searchParams.get("live") === "true";
    const q = (url.searchParams.get("q") || "").toLowerCase();
    const limit = Math.max(1, Math.min(100,
      Number(url.searchParams.get("limit")) || 50));
    const offset = Math.max(0,
      Number(url.searchParams.get("offset")) || 0);

    if (sportArg !== "all" && !ALLOWED.includes(sportArg)) {
      return reply({ success: false, error: "Unsupported sport",
        allowedSports: ALLOWED }, 400);
    }

    const rawEvents = await fetchEvents();
    const normalized = rawEvents.map(normalize);

    let matches = normalized.filter(event => {
      if (!event.sport || !event.tokens.length) return false;
      if (sportArg !== "all" && event.sport !== sportArg) return false;
      if (liveOnly && !event.live) return false;
      if (event.closed) return false;

      if (q && ![
        event.title, event.slug, event.sport,
        ...event.teams, ...event.tokens.map(t => t.label)
      ].join(" ").toLowerCase().includes(q)) return false;

      if (day === "today" || day === "tomorrow") {
        if (!event.scheduledAt) return false;
        const matchDate = istDateKey(new Date(event.scheduledAt));
        const now = new Date();
        const target = new Date(now.toLocaleString("en-US", {
          timeZone: "Asia/Kolkata"
        }));
        if (day === "tomorrow") target.setDate(target.getDate() + 1);
        const targetKey = istDateKey(target);
        if (matchDate !== targetKey) return false;
      }

      return true;
    });

    matches.sort((a, b) => {
      if (a.live !== b.live) return a.live ? -1 : 1;
      return (a.scheduledAt || "9999").localeCompare(
        b.scheduledAt || "9999"
      );
    });

    const total = matches.length;
    matches = matches.slice(offset, offset + limit);

    return reply({
      success: true,
      worker: "crystal-live-odds",
      source: "Polymarket Gamma + public CLOB",
      sport: sportArg,
      todayIST: todayIST(),
      count: matches.length,
      total,
      offset,
      limit,
      hasMore: offset + matches.length < total,
      data: matches
    });
  }

  return reply({ success: false, error: "Not found" }, 404);
}

export default {
  async fetch(request) {
    try {
      return await handle(request);
    } catch (error) {
      return reply({
        success: false,
        error: error && error.message
          ? error.message : "Unknown error",
        worker: "crystal-live-odds"
      }, 502);
    }
  }
};