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
    headers: {
      ...HEADERS,
      "Content-Type": "application/json"
    }
  });
}
function arr(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}
function text(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(text).join(" ");
  if (typeof value === "object") {
    return [
      value.name,
      value.label,
      value.slug,
      value.title,
      value.value
    ].filter(Boolean).join(" ");
  }
  return String(value);
}
function validDate(value) {
  if (!value || typeof value !== "string") return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms);
}
function slugDate(value) {
  const s = String(value || "");
  const match = s.match(
    /(?:^|[-_])((?:20\d{2})-\d{2}-\d{2})(?=$|[-_])/
  );
  if (!match) return null;
  const d = validDate(match[1] + "T12:00:00Z");
  if (!d || d.toISOString().slice(0, 10) !== match[1]) {
    return null;
  }
  return d;
}
/*
 * Do not use Gamma startDate/endDate as a fixture date:
 * these can represent event creation or market expiry.
 * Prefer explicit scheduled fields, then a date in the slug.
 */
function scheduledDate(event) {
  const explicitFields = [
    event.scheduledStartTime,
    event.scheduled_start_time,
    event.gameStartTime,
    event.game_start_time,
    event.matchStartTime,
    event.match_start_time,
    event.startTime,
    event.start_time
  ];
  for (const value of explicitFields) {
    const d = validDate(value);
    if (d) return d;
  }
  return slugDate(event.slug);
}
function eventText(event) {
  const tagText = arr(event.tags).map(text).join(" ");
  const categoryText = [
    text(event.sport),
    text(event.sportsMarketType),
    text(event.category),
    text(event.series),
    text(event.league),
    text(event.competition),
    text(event.tournament),
    tagText
  ].join(" ");
  return {
    metadata: categoryText.toLowerCase(),
    title: [
      event.title,
      event.slug,
      ...arr(event.markets).flatMap(m => [
        m.question,
        m.groupItemTitle,
        m.slug
      ])
    ].map(text).join(" ").toLowerCase()
  };
}
function sportOf(event) {
  const { metadata, title } = eventText(event);
  const all = metadata + " " + title;
  /*
   * Exclude esports before checking sport names.
   * A generic "vs" is NOT evidence of football.
   */
  const esports =
    /\b(counter[\s-]?strike|cs2|csgo|dota\s*2|valorant|league of legends|lol esports|esports|e-sports|starcraft|overwatch|rainbow six|rocket league|honor of kings|mobile legends|pubg esports|call of duty esports)\b/i;
  if (esports.test(all)) return null;
  const cricket =
    /\b(cricket|t20|odi|ipl|ashes|wicket|test cricket|big bash|bbl|psl|cpl|hundred cricket|icc cricket|ranji trophy)\b/i;
  const tennis =
    /\b(tennis|atp|wta|challenger tour|grand slam|wimbledon|roland garros|australian open tennis|us open tennis|davis cup|billie jean king cup)\b/i;
  /*
   * Football needs explicit football/soccer or competition evidence.
   * Do not classify an arbitrary "Team A vs Team B" as football.
   */
  const football =
    /\b(football|soccer|premier league|champions league|europa league|conference league|la liga|serie a|bundesliga|ligue 1|mls|uefa|fifa|world cup|world cup qualifiers|fa cup|carabao cup|copa del rey|copa america|afcon|afc asian cup|eredivisie|primeira liga|saudi pro league|liga mx|nws[l]?)\b/i;
  if (cricket.test(metadata)) return "cricket";
  if (tennis.test(metadata)) return "tennis";
  if (football.test(metadata)) return "football";
  if (cricket.test(title)) return "cricket";
  if (tennis.test(title)) return "tennis";
  if (football.test(title)) return "football";
  return null;
}
function explicitLive(event) {
  if (
    event.live === true ||
    event.isLive === true ||
    event.inplay === true ||
    event.inPlay === true
  ) return true;
  const status = String(
    event.gameStatus || event.status || ""
  ).toLowerCase();
  return [
    "live",
    "in-play",
    "in play",
    "in_progress",
    "in progress"
  ].includes(status);
}
function extractTeams(title) {
  const value = String(title || "").replace(
    /^(Tennis|Football|Soccer|Cricket)\s*:\s*/i,
    ""
  );
  const parts = value.split(/\s+vs\.?\s+|\s+v\s+/i);
  if (parts.length >= 2) {
    return [
      parts[0].trim(),
      parts.slice(1).join(" vs ").trim()
    ];
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
      value.token_id ||
      value.tokenId ||
      value.asset_id ||
      value.assetId ||
      value.id
    );
  }
  return null;
}
function marketTokens(market, teams) {
  const outcomes = arr(market.outcomes).map(text);
  const ids = arr(
    market.clobTokenIds ||
    market.clob_token_ids ||
    market.tokenIds ||
    market.tokens
  ).map(tokenId);
  const result = [];
  const question = String(market.question || market.title || "");
  const conditionId = market.conditionId ||
    market.condition_id || null;
  const yesNo = outcomes.length === 2 &&
    outcomes.every(o => /^(yes|no)$/i.test(o));
  if (yesNo && ids.length >= 2 && teams.length === 2) {
    const lower = question.toLowerCase();
    const team = teams.find(t =>
      t && lower.includes(t.toLowerCase())
    );
    if (team) {
      const index = outcomes.findIndex(
        o => o.toLowerCase() === "yes"
      );
      if (ids[index]) {
        result.push({
          id: ids[index],
          label: team,
          team,
          conditionId,
          question
        });
      }
    }
  } else {
    for (let i = 0; i < Math.min(outcomes.length, ids.length); i++) {
      if (!ids[i]) continue;
      result.push({
        id: ids[i],
        label: outcomes[i] || `Outcome ${i + 1}`,
        team: outcomes[i] || null,
        conditionId,
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
    const items = Array.isArray(data)
      ? data
      : Array.isArray(data.data) ? data.data : [];
    if (!items.length) break;
    for (const event of items) {
      const id = String(event.id || event.slug || "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      all.push(event);
    }
    if (
      items.length < pageSize ||
      data.has_more === false ||
      data.hasMore === false
    ) break;
  }
  return all;
}
function istDateKey(date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const get = type => parts.find(p => p.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
function todayIST() {
  return istDateKey(new Date());
}
function addDaysToDateKey(key, amount) {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + amount);
  return d.toISOString().slice(0, 10);
}
function matchesDay(scheduledAt, day) {
  if (!day) return true;
  if (!scheduledAt) return false;
  const actual = istDateKey(new Date(scheduledAt));
  const today = todayIST();
  const target = day === "tomorrow"
    ? addDaysToDateKey(today, 1)
    : today;
  return actual === target;
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
        "/health",
        "/sports",
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
    const side = (
      url.searchParams.get("side") || "BUY"
    ).toUpperCase();
    if (!/^\d{1,100}$/.test(id) ||
        !["BUY", "SELL"].includes(side)) {
      return reply({
        success: false,
        error: "Invalid token_id or side"
      }, 400);
    }
    const result = await getJson(
      `${CLOB}/price?token_id=${encodeURIComponent(id)}&side=${side}`
    );
    const price = Number(result.price);
    const valid = Number.isFinite(price) &&
      price >= 0 && price <= 1;
    return reply({
      success: true,
      tokenId: id,
      side,
      price: valid ? price : null,
      cents: valid ? price * 100 : null,
      decimalOdds: valid && price > 0 ? 1 / price : null,
      timestamp: new Date().toISOString()
    });
  }
  if (path === "/book") {
    const id = url.searchParams.get("token_id") || "";
    if (!/^\d{1,100}$/.test(id)) {
      return reply({
        success: false,
        error: "Invalid token_id"
      }, 400);
    }
    const result = await getJson(
      `${CLOB}/book?token_id=${encodeURIComponent(id)}`
    );
    return reply({
      success: true,
      tokenId: id,
      book: result
    });
  }
  if (path === "/event") {
    const id = url.searchParams.get("id") || "";
    if (!id) {
      return reply({ success: false, error: "id required" }, 400);
    }
    const result = await getJson(
      `${GAMMA}/events?id=${encodeURIComponent(id)}`
    );
    const event = Array.isArray(result)
      ? result[0]
      : result;
    if (!event) {
      return reply({ success: false, error: "Not found" }, 404);
    }
    return reply({
      success: true,
      data: normalize(event),
      raw: event
    });
  }
  if (path === "/matches") {
    const sportArg = (
      url.searchParams.get("sport") || "all"
    ).toLowerCase();
    const day = (
      url.searchParams.get("day") || ""
    ).toLowerCase();
    const liveOnly = url.searchParams.get("live") === "true";
    const q = (
      url.searchParams.get("q") || ""
    ).trim().toLowerCase();
    const limit = Math.max(1, Math.min(
      100,
      Number(url.searchParams.get("limit")) || 50
    ));
    const offset = Math.max(
      0,
      Number(url.searchParams.get("offset")) || 0
    );
    if (sportArg !== "all" && !ALLOWED.includes(sportArg)) {
      return reply({
        success: false,
        error: "Unsupported sport",
        allowedSports: ALLOWED
      }, 400);
    }
    if (day && !["today", "tomorrow"].includes(day)) {
      return reply({
        success: false,
        error: "day must be today or tomorrow"
      }, 400);
    }
    const rawEvents = await fetchEvents();
    const normalized = rawEvents.map(normalize);
    let matches = normalized.filter(event => {
      if (!event.sport) return false;
      if (sportArg !== "all" && event.sport !== sportArg) return false;
      if (event.closed || !event.active) return false;
      if (!event.tokens.length) return false;
      if (liveOnly && !event.live) return false;
      if (!matchesDay(event.scheduledAt, day)) return false;
      if (q) {
        const searchable = [
          event.title,
          event.slug,
          event.sport,
          ...event.teams,
          ...event.tokens.map(t => t.label),
          ...event.tokens.map(t => t.question)
        ].join(" ").toLowerCase();
        if (!searchable.includes(q)) return false;
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
  return reply({
    success: false,
    error: "Not found"
  }, 404);
}
export default {
  async fetch(request) {
    try {
      return await handle(request);
    } catch (error) {
      return reply({
        success: false,
        error: error && error.message
          ? error.message
          : "Unknown error",
        worker: "crystal-live-odds"
      }, 502);
    }
  }
};

