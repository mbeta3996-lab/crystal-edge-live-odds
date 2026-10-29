
"use strict";

const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";

const ALLOWED = ["cricket", "tennis", "football"];
const PAGE_SIZE = 50;
const MAX_PAGES = 40;
const FETCH_TIMEOUT_MS = 12000;

const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8"
};

function reply(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: HEADERS
  });
}

function arr(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function str(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  if (typeof value === "object") {
    return String(
      value.label ??
      value.name ??
      value.value ??
      value.title ??
      ""
    ).trim();
  }
  return "";
}

function truthy(value) {
  return value === true ||
    value === 1 ||
    value === "true" ||
    value === "1";
}

function validDate(value) {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time) : null;
}

function slugDate(value) {
  const match = String(value || "").match(
    /(?:^|[-_])((?:202[5-9]|203\d)-\d{2}-\d{2})(?:[-_]|$)/
  );

  if (!match) return null;

  const date = match[1];
  const [year, month, day] = date.split("-").map(Number);
  const check = new Date(Date.UTC(year, month - 1, day));

  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) return null;

  return date;
}

function istDateKey(value) {
  const date = value instanceof Date ? value : validDate(value);
  if (!date) return null;

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

function todayIST() {
  return istDateKey(new Date());
}

function shiftDateKey(key, days) {
  const [y, m, d] = key.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));

  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0")
  ].join("-");
}

/*
 * Only explicit match-schedule fields are accepted as kickoff times.
 * event.startDate/endDate are deliberately NOT used as kickoff times.
 */
function scheduledTime(event) {
  const fields = [
    event.scheduledStartTime,
    event.matchStartTime,
    event.gameStartTime,
    event.eventStartTime,
    event.startTime
  ];

  for (const field of fields) {
    const date = validDate(field);
    if (date) return date;
  }

  return null;
}

function scheduleDate(event, scheduledAt) {
  if (scheduledAt) return istDateKey(scheduledAt);

  return (
    slugDate(event.slug) ||
    slugDate(event.ticker) ||
    slugDate(event.title)
  );
}

function isEsports(event) {
  const parts = [
    event.title,
    event.slug,
    event.ticker,
    event.sport,
    event.category,
    event.series,
    event.description,
    ...arr(event.tags).map(str),
    ...arr(event.markets).flatMap(m => [
      m.question,
      m.slug,
      m.groupItemTitle
    ])
  ];

  const value = parts.join(" ").toLowerCase();

  return /\b(counter[\s-]?strike|cs2|csgo|valorant|dota\s*2|league of legends|lol esports|esports|e[- ]sports|rocket league|rainbow six|overwatch|starcraft|call of duty esports|mobile legends|pubg esports|fortnite esports|honor of kings|wild rift)\b/i.test(value);
}

function sportOf(event) {
  if (isEsports(event)) return null;

  const tagValues = arr(event.tags).map(t => {
    if (t && typeof t === "object") {
      return [
        t.label,
        t.name,
        t.slug,
        t.value
      ].map(str).join(" ");
    }
    return str(t);
  });

  const parts = [
    event.sport,
    event.category,
    event.series,
    event.league,
    event.title,
    event.slug,
    event.ticker,
    ...tagValues
  ];

  const value = parts.join(" ").toLowerCase();

  if (/\b(cricket|t20|odi cricket|test cricket|ipl|bbl|psl|wpl|icc|ashes|ranji trophy|county cricket|world test championship)\b/i.test(value)) {
    return "cricket";
  }

  if (/\b(tennis|atp|wta|challenger tennis|itf tennis|grand slam|roland garros|french open|wimbledon|us open tennis|australian open tennis|davis cup|billie jean king cup)\b/i.test(value)) {
    return "tennis";
  }

  if (/\b(soccer|association football|premier league|champions league|la liga|serie a|bundesliga|ligue 1|mls|epl|uefa|fifa|world cup|europa league|conference league|fa cup|copa america|afcon|international football|football match|football league)\b/i.test(value)) {
    return "football";
  }

  return null;
}

function explicitLive(event) {
  const fields = [
    event.live,
    event.isLive,
    event.inPlay,
    event.is_in_play
  ];

  if (fields.some(truthy)) return true;

  const status = [
    event.status,
    event.gameStatus,
    event.eventStatus
  ].map(str).join(" ").toLowerCase();

  return /\b(live|in[- ]play|inprogress|in progress)\b/.test(status);
}

function eventIsActive(event) {
  return event.active !== false &&
    event.closed !== true &&
    event.archived !== true;
}

function eventIsClosed(event) {
  return event.closed === true ||
    event.closed === "true" ||
    event.archived === true;
}

function splitTitle(title) {
  const source = String(title || "").trim();
  if (!source) return [];

  /*
   * Some sports titles repeat the matchup after a series prefix.
   * Prefer the last matchup-like segment.
   */
  const segments = source.split(":").map(x => x.trim());
  let candidate = source;

  for (let i = segments.length - 1; i >= 0; i--) {
    if (/\b(?:vs\.?|v)\b/i.test(segments[i])) {
      candidate = segments[i];
      break;
    }
  }

  const pieces = candidate.split(
    /\s+(?:vs?\.?|versus)\s+/i
  );

  if (pieces.length < 2) return [];

  const clean = value => value
    .replace(/\s*[-–—]\s*(?:match winner|winner|match result).*$/i, "")
    .replace(/\s*\((?:bo\d|best of).*$/i, "")
    .replace(/^\s*(?:match winner|winner):?\s*/i, "")
    .trim();

  const first = clean(pieces[0]);
  const second = clean(pieces.slice(1).join(" vs "));

  if (!first || !second) return [];

  return [first, second];
}

function tokenId(value) {
  if (typeof value === "string" || typeof value === "number") {
    const id = String(value).trim();
    return /^\d{1,120}$/.test(id) ? id : null;
  }

  if (value && typeof value === "object") {
    return tokenId(
      value.token_id ??
      value.tokenId ??
      value.asset_id ??
      value.assetId ??
      value.id
    );
  }

  return null;
}

function marketTokens(market, eventTeams) {
  const outcomes = arr(market.outcomes).map(str);
  const ids = arr(
    market.clobTokenIds ??
    market.clob_token_ids ??
    market.tokenIds ??
    market.token_ids
  ).map(tokenId);

  if (!outcomes.length || !ids.length) return [];

  const question = str(market.question || market.title);
  const conditionId = str(market.conditionId || market.condition_id);
  const tokens = [];

  for (let i = 0; i < Math.min(outcomes.length, ids.length); i++) {
    const id = ids[i];
    const label = outcomes[i];

    if (!id || !label) continue;

    let team = label;

    if (/^(yes|no)$/i.test(label)) {
      const q = question.toLowerCase();

      const matchingTeam = eventTeams.find(name =>
        name && q.includes(name.toLowerCase())
      );

      team = matchingTeam || label;
    }

    tokens.push({
      id,
      label,
      team,
      conditionId,
      question
    });
  }

  return tokens;
}

function normalize(event) {
  const sport = sportOf(event);
  if (!sport || !ALLOWED.includes(sport)) return null;

  const title = str(event.title || event.name);
  const teams = splitTitle(title);

  if (teams.length !== 2) return null;

  /*
   * A duplicated team name is usually malformed event metadata.
   * Reject rather than inventing a second participant.
   */
  if (teams[0].toLowerCase() === teams[1].toLowerCase()) {
    return null;
  }

  const markets = arr(event.markets);
  const tokens = [];
  const seenTokens = new Set();

  for (const market of markets) {
    if (!market || typeof market !== "object") continue;

    if (
      market.closed === true ||
      market.archived === true ||
      market.active === false
    ) continue;

    for (const token of marketTokens(market, teams)) {
      if (seenTokens.has(token.id)) continue;
      seenTokens.add(token.id);
      tokens.push(token);
    }
  }

  if (!tokens.length) return null;

  const scheduledAt = scheduledTime(event);
  const scheduledDate = scheduleDate(event, scheduledAt);
  const live = explicitLive(event);

  return {
    id: str(event.id),
    title,
    slug: str(event.slug),
    sport,
    teams,
    scheduledAt: scheduledAt ? scheduledAt.toISOString() : null,
    scheduledDate,
    scheduleSource: scheduledAt ? "explicit" : (scheduledDate ? "slug-date-only" : null),
    live,
    active: eventIsActive(event),
    closed: eventIsClosed(event),
    tokens,
    marketCount: markets.length,
    url: event.slug
      ? `https://polymarket.com/event/${encodeURIComponent(event.slug)}`
      : null
  };
}

async function getJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Accept": "application/json"
      },
      signal: controller.signal
    });

    const raw = await response.text();

    if (!response.ok) {
      throw new Error(`Upstream HTTP ${response.status}: ${raw.slice(0, 200)}`);
    }

    try {
      return JSON.parse(raw);
    } catch {
      throw new Error("Upstream returned invalid JSON");
    }
  } finally {
    clearTimeout(timer);
  }
}

async function fetchEvents() {
  const all = [];
  const seen = new Set();
  let pagesScanned = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const offset = page * PAGE_SIZE;

    const params = new URLSearchParams({
      active: "true",
      closed: "false",
      limit: String(PAGE_SIZE),
      offset: String(offset),
      order: "startDate",
      ascending: "false"
    });

    const result = await getJson(`${GAMMA}/events?${params}`);
    const rows = Array.isArray(result)
      ? result
      : Array.isArray(result?.data)
        ? result.data
        : [];

    pagesScanned++;

    if (!rows.length) break;

    for (const event of rows) {
      const id = str(event?.id);
      const slug = str(event?.slug);
      const key = id || slug;

      if (!key || seen.has(key)) continue;

      seen.add(key);
      all.push(event);
    }

    if (rows.length < PAGE_SIZE) break;
  }

  return {
    events: all,
    pagesScanned
  };
}

function parseBoolParam(value) {
  return value === "1" || value === "true" || value === "yes";
}

function dayFilterFor(url) {
  const raw = (
    url.searchParams.get("day") ||
    url.searchParams.get("date") ||
    url.searchParams.get("filter") ||
    ""
  ).toLowerCase();

  if (["today", "tomorrow", "live", "upcoming", "all"].includes(raw)) {
    return raw;
  }

  if (parseBoolParam(url.searchParams.get("live"))) {
    return "live";
  }

  return "upcoming";
}

function dateMatches(match, day) {
  const today = todayIST();
  const tomorrow = shiftDateKey(today, 1);
  const key = match.scheduledDate;

  if (day === "live") return match.live;
  if (match.live) return true;

  if (!key) return false;

  if (day === "today") return key === today;
  if (day === "tomorrow") return key === tomorrow;
  if (day === "upcoming") return key >= today;

  return key >= today;
}

function normalizeLimit(value, fallback = 100) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(100, Math.floor(parsed)));
}

async function handle(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: HEADERS
    });
  }

  if (request.method !== "GET") {
    return reply({
      success: false,
      error: "method_not_allowed"
    }, 405);
  }

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

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
      sports: [
        { id: "cricket", label: "Cricket" },
        { id: "tennis", label: "Tennis" },
        { id: "football", label: "Football" }
      ]
    });
  }

  if (path === "/price") {
    const id = url.searchParams.get("token_id") || "";
    const side = (url.searchParams.get("side") || "BUY").toUpperCase();

    if (!/^\d{1,120}$/.test(id)) {
      return reply({ success: false, error: "invalid_token_id" }, 400);
    }

    if (!["BUY", "SELL"].includes(side)) {
      return reply({ success: false, error: "invalid_side" }, 400);
    }

    const params = new URLSearchParams({
      token_id: id,
      side
    });

    const data = await getJson(`${CLOB}/price?${params}`);
    const price = Number(data?.price);

    if (!Number.isFinite(price) || price <= 0 || price > 1) {
      return reply({
        success: true,
        tokenId: id,
        side,
        price: null,
        cents: null,
        decimalOdds: null,
        source: "public CLOB"
      });
    }

    return reply({
      success: true,
      tokenId: id,
      side,
      price,
      cents: price * 100,
      decimalOdds: 1 / price,
      timestamp: new Date().toISOString(),
      source: "public CLOB"
    });
  }

  if (path === "/book") {
    const id = url.searchParams.get("token_id") || "";

    if (!/^\d{1,120}$/.test(id)) {
      return reply({ success: false, error: "invalid_token_id" }, 400);
    }

    const params = new URLSearchParams({ token_id: id });
    const data = await getJson(`${CLOB}/book?${params}`);

    return reply({
      success: true,
      tokenId: id,
      book: data
    });
  }

  if (path === "/event") {
    const id = url.searchParams.get("id") || "";

    if (!id || id.length > 200) {
      return reply({ success: false, error: "missing_or_invalid_event_id" }, 400);
    }

    const params = new URLSearchParams({ id });
    const data = await getJson(`${GAMMA}/events?${params}`);

    const rows = Array.isArray(data)
      ? data
      : Array.isArray(data?.data)
        ? data.data
        : data && typeof data === "object"
          ? [data]
          : [];

    const event = rows.find(item => str(item.id) === id);

    if (!event) {
      return reply({
        success: false,
        error: "event_not_found",
        id
      }, 404);
    }

    return reply({
      success: true,
      event: normalize(event),
      raw: event
    });
  }

  if (path === "/matches") {
    const sportParam = (
      url.searchParams.get("sport") || "all"
    ).toLowerCase();

    if (sportParam !== "all" && !ALLOWED.includes(sportParam)) {
      return reply({
        success: false,
        error: "unsupported_sport",
        allowedSports: ALLOWED
      }, 400);
    }

    const limit = normalizeLimit(url.searchParams.get("limit"), 100);
    const offset = Math.max(
      0,
      Math.min(100000, Number(url.searchParams.get("offset")) || 0)
    );

    const query = (
      url.searchParams.get("q") ||
      url.searchParams.get("search") ||
      ""
    ).trim().toLowerCase();

    const day = dayFilterFor(url);

    const { events, pagesScanned } = await fetchEvents();

    const matches = [];
    const seen = new Set();

    for (const event of events) {
      if (!eventIsActive(event)) continue;

      const match = normalize(event);
      if (!match) continue;

      if (sportParam !== "all" && match.sport !== sportParam) {
        continue;
      }

      if (query) {
        const haystack = [
          match.title,
          match.slug,
          match.sport,
          ...match.teams
        ].join(" ").toLowerCase();

        if (!haystack.includes(query)) continue;
      }

      if (!dateMatches(match, day)) continue;

      const key = match.id || match.slug;
      if (!key || seen.has(key)) continue;

      seen.add(key);
      matches.push(match);
    }

    matches.sort((a, b) => {
      if (a.live !== b.live) return a.live ? -1 : 1;

      const da = a.scheduledDate || "9999-99-99";
      const db = b.scheduledDate || "9999-99-99";

      if (da !== db) return da.localeCompare(db);

      const ta = a.scheduledAt ? Date.parse(a.scheduledAt) : Infinity;
      const tb = b.scheduledAt ? Date.parse(b.scheduledAt) : Infinity;

      return ta - tb;
    });

    const page = matches.slice(offset, offset + limit);

    return reply({
      success: true,
      worker: "crystal-live-odds",
      source: "Polymarket Gamma + public CLOB",
      sport: sportParam,
      day,
      todayIST: todayIST(),
      count: page.length,
      total: matches.length,
      offset,
      limit,
      hasMore: offset + page.length < matches.length,
      pagesScanned,
      eventsScanned: events.length,
      data: page
    });
  }

  return reply({
    success: false,
    error: "not_found",
    path,
    availableEndpoints: [
      "/health",
      "/sports",
      "/matches",
      "/event?id=EVENT_ID",
      "/price?token_id=TOKEN_ID&side=BUY",
      "/book?token_id=TOKEN_ID"
    ]
  }, 404);
}

export default {
  async fetch(request) {
    try {
      return await handle(request);
    } catch (error) {
      return reply({
        success: false,
        worker: "crystal-live-odds",
        error: error?.name === "AbortError"
          ? "upstream_timeout"
          : "upstream_error",
        message: String(error?.message || error).slice(0, 300)
      }, 502);
    }
  }
};

