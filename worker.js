
const GAMMA = "https://gamma-api.polymarket.com";

const ALLOWED_SPORTS = ["cricket", "tennis", "football"];
const MAX_SCAN_PAGES = 10;
const PAGE_SIZE = 100;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: CORS_HEADERS
  });
}

function normalise(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/&amp;/g, "&")
    .replace(/[’']/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function getMarketTokens(market) {
  const tokens = [];

  // Standard Gamma market format
  const ids = asArray(market.clobTokenIds);
  for (const id of ids) {
    if (id != null && String(id).trim()) {
      tokens.push(String(id));
    }
  }

  // Some responses provide token IDs inside outcomes
  const outcomes = asArray(market.outcomes);
  for (const outcome of outcomes) {
    if (outcome && typeof outcome === "object") {
      const id = outcome.tokenId ?? outcome.token_id;
      if (id != null && String(id).trim()) {
        tokens.push(String(id));
      }
    }
  }

  return [...new Set(tokens)];
}

function eventText(event) {
  const parts = [
    event.title,
    event.slug,
    event.description,
    event.ticker,
    event.series?.title
  ];

  for (const tag of event.tags || []) {
    if (typeof tag === "string") parts.push(tag);
    else if (tag && typeof tag === "object") {
      parts.push(tag.label, tag.slug, tag.name);
    }
  }

  return normalise(parts.filter(Boolean).join(" "));
}

function detectSport(event) {
  const text = eventText(event);

  // Avoid finance, politics and unrelated price predictions.
  const blocked = [
    "bitcoin", "ethereum", "crypto", "stock price",
    "s&p 500", "nasdaq", "dow jones", "gold price",
    "presidential election", "election winner",
    "federal reserve", "fomc", "interest rate",
    "ballon d'or", "ballon dor", "player of the year",
    "league winner", "champion outright", "to win the league",
    "season winner", "outright", "top scorer award"
  ];

  if (blocked.some(term => text.includes(term))) return null;

  const cricketTerms = [
    "cricket", "ipl", "t20", "odi", "test match",
    "big bash", "bbl", "psl", "cpl", "the hundred",
    "ranji trophy", "wpl", "ashes"
  ];

  const tennisTerms = [
    "tennis", "atp", "wta", "grand slam",
    "wimbledon", "roland garros", "french open",
    "us open", "australian open", "challenger"
  ];

  const footballTerms = [
    "football", "soccer", "premier league",
    "champions league", "europa league", "la liga",
    "serie a", "bundesliga", "ligue 1",
    "mls", "fa cup", "world cup", "epl",
    "uefa", "fifa", "eredivisie"
  ];

  const has = terms => terms.some(term => text.includes(term));

  // Prefer explicit cricket/tennis indicators before football.
  if (has(cricketTerms)) return "cricket";
  if (has(tennisTerms)) return "tennis";
  if (has(footballTerms)) return "football";

  return null;
}

function isMatchEvent(event) {
  const title = normalise(event.title);
  if (!title) return false;

  const blocked = [
    "champion", "championship winner", "league winner",
    "season winner", "top scorer", "relegated",
    "qualify for", "win the tournament",
    "most valuable player", "mvp", "award"
  ];

  if (blocked.some(term => title.includes(term))) return false;

  // Match-style titles, including "A vs. B", "A v B"
  // and common tennis/cricket event title formats.
  const hasVersus = /\b(vs?\.?|versus)\b/i.test(title);

  // Some genuine events use a dash or "at" between opponents.
  const hasOpponentSeparator =
    /\s[-–—]\s/.test(title) ||
    /\s@\s/.test(title);

  return hasVersus || hasOpponentSeparator;
}

function isUsableMarket(market) {
  if (!market || market.closed === true) return false;
  if (market.active === false) return false;
  if (market.archived === true) return false;

  const tokens = getMarketTokens(market);
  return tokens.length >= 2;
}

function marketSummary(market) {
  const tokens = getMarketTokens(market);

  return {
    id: market.id ?? null,
    question: market.question ?? market.groupItemTitle ?? "",
    slug: market.slug ?? null,
    active: market.active !== false,
    closed: market.closed === true,
    acceptingOrders: market.acceptingOrders ?? null,
    enableOrderBook: market.enableOrderBook ?? null,
    outcomes: asArray(market.outcomes),
    outcomePrices: asArray(market.outcomePrices),
    clobTokenIds: tokens,
    bestBid: market.bestBid ?? null,
    bestAsk: market.bestAsk ?? null,
    spread: market.spread ?? null,
    liquidity: market.liquidity ?? null,
    volume: market.volume ?? null
  };
}

function eventSummary(event) {
  const sport = detectSport(event);
  const markets = (event.markets || [])
    .filter(isUsableMarket)
    .map(marketSummary);

  const allTokens = [
    ...new Set(markets.flatMap(market => market.clobTokenIds))
  ];

  return {
    id: String(event.id ?? ""),
    title: event.title ?? "",
    slug: event.slug ?? "",
    description: event.description ?? "",
    sport,
    startDate: event.startDate ?? null,
    endDate: event.endDate ?? null,
    active: event.active !== false,
    closed: event.closed === true,
    archived: event.archived === true,
    live: event.live ?? null,
    eventUrl: event.slug
      ? `https://polymarket.com/event/${event.slug}`
      : null,
    marketCount: markets.length,
    tokenIds: allTokens,
    markets
  };
}

function isEligible(event) {
  if (!event || event.active === false) return false;
  if (event.closed === true || event.archived === true) return false;

  if (!detectSport(event)) return false;
  if (!isMatchEvent(event)) return false;

  const markets = (event.markets || []).filter(isUsableMarket);
  return markets.length > 0;
}

async function fetchPage(offset) {
  const url = new URL(`${GAMMA}/events`);

  url.searchParams.set("active", "true");
  url.searchParams.set("closed", "false");
  url.searchParams.set("limit", String(PAGE_SIZE));
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("order", "startDate");
  url.searchParams.set("ascending", "true");

  const response = await fetch(url.toString(), {
    headers: { Accept: "application/json" }
  });

  if (!response.ok) {
    throw new Error(`Polymarket Gamma returned HTTP ${response.status}`);
  }

  const data = await response.json();
  return Array.isArray(data) ? data : [];
}

async function scanEvents() {
  const pages = [];

  // Parallel requests reduce the time spent waiting for Gamma.
  for (let offset = 0; offset < MAX_SCAN_PAGES * PAGE_SIZE; offset += PAGE_SIZE) {
    pages.push(offset);
  }

  const results = await Promise.allSettled(
    pages.map(offset => fetchPage(offset))
  );

  const allEvents = [];
  const errors = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];

    if (result.status === "fulfilled") {
      allEvents.push(...result.value);
    } else {
      errors.push({
        offset: pages[i],
        message: String(result.reason?.message || result.reason)
      });
    }
  }

  const unique = new Map();

  for (const event of allEvents) {
    if (event?.id != null) unique.set(String(event.id), event);
  }

  return {
    events: [...unique.values()],
    scanned: allEvents.length,
    uniqueCount: unique.size,
    errors
  };
}

async function getEventById(id) {
  const url = new URL(`${GAMMA}/events`);
  url.searchParams.set("id", String(id));

  const response = await fetch(url.toString(), {
    headers: { Accept: "application/json" }
  });

  if (!response.ok) {
    throw new Error(`Polymarket Gamma returned HTTP ${response.status}`);
  }

  const data = await response.json();
  if (Array.isArray(data)) {
    return data.find(event => String(event.id) === String(id)) || null;
  }

  return data && String(data.id) === String(id) ? data : null;
}

async function handleRequest(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: CORS_HEADERS
    });
  }

  if (request.method !== "GET") {
    return json({ success: false, error: "Method not allowed" }, 405);
  }

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const startedAt = Date.now();

  try {
    if (path === "/" || path === "/health") {
      return json({
        success: true,
        status: "ok",
        worker: "crystal-live-odds",
        provider: "Polymarket Gamma + public CLOB",
        gamma: GAMMA,
        allowedSports: ALLOWED_SPORTS,
        pageSize: PAGE_SIZE,
        maxScanPages: MAX_SCAN_PAGES,
        endpoints: [
          "/health",
          "/sports",
          "/matches?limit=100&offset=0&sport=all",
          "/events",
          "/event?id=EVENT_ID"
        ],
        timestamp: new Date().toISOString()
      });
    }

    if (path === "/sports") {
      return json({
        success: true,
        sports: ALLOWED_SPORTS
      });
    }

    if (path === "/event") {
      const id = url.searchParams.get("id");

      if (!id) {
        return json({
          success: false,
          error: "Missing event id. Use /event?id=EVENT_ID"
        }, 400);
      }

      const event = await getEventById(id);

      if (!event) {
        return json({
          success: false,
          error: "Event not found",
          id
        }, 404);
      }

      return json({
        success: true,
        worker: "crystal-live-odds",
        data: eventSummary(event),
        requestMs: Date.now() - startedAt
      });
    }

    if (path === "/matches" || path === "/events") {
      const sportParam = normalise(url.searchParams.get("sport") || "all");
      const search = normalise(url.searchParams.get("q") || "");
      const limit = Math.max(
        1,
        Math.min(200, Number.parseInt(url.searchParams.get("limit") || "100", 10) || 100)
      );
      const offset = Math.max(
        0,
        Number.parseInt(url.searchParams.get("offset") || "0", 10) || 0
      );

      if (sportParam !== "all" && !ALLOWED_SPORTS.includes(sportParam)) {
        return json({
          success: false,
          error: "Unsupported sport",
          allowedSports: ["all", ...ALLOWED_SPORTS]
        }, 400);
      }

      const scan = await scanEvents();

      let matches = scan.events.filter(isEligible);

      if (sportParam !== "all") {
        matches = matches.filter(event => detectSport(event) === sportParam);
      }

      if (search) {
        matches = matches.filter(event =>
          eventText(event).includes(search)
        );
      }

      matches.sort((a, b) => {
        const dateA = Date.parse(a.startDate || "");
        const dateB = Date.parse(b.startDate || "");

        if (Number.isFinite(dateA) && Number.isFinite(dateB)) {
          return dateA - dateB;
        }

        return 0;
      });

      const totalMatchesFound = matches.length;
      const data = matches
        .slice(offset, offset + limit)
        .map(eventSummary);

      return json({
        success: true,
        worker: "crystal-live-odds",
        source: "Polymarket Gamma",
        sport: sportParam,
        allowedSports: ALLOWED_SPORTS,
        count: data.length,
        totalMatchesFound,
        scannedEvents: scan.scanned,
        uniqueEvents: scan.uniqueCount,
        limit,
        offset,
        requestMs: Date.now() - startedAt,
        timestamp: new Date().toISOString(),
        warnings: scan.errors,
        data
      });
    }

    return json({
      success: false,
      error: "Endpoint not found",
      availableEndpoints: [
        "/health",
        "/sports",
        "/matches",
        "/events",
        "/event?id=EVENT_ID"
      ]
    }, 404);

  } catch (error) {
    return json({
      success: false,
      worker: "crystal-live-odds",
      error: String(error?.message || error),
      requestMs: Date.now() - startedAt,
      timestamp: new Date().toISOString()
    }, 502);
  }
}

export default {
  async fetch(request) {
    return handleRequest(request);
  }
};