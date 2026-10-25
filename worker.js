
const GAMMA = "https://gamma-api.polymarket.com";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

const SPORTS = ["cricket", "tennis", "football"];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: CORS
  });
}

function parseJSON(value, fallback = []) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return fallback;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function textOf(value) {
  if (Array.isArray(value)) {
    return value.map(textOf).join(" ");
  }
  if (value && typeof value === "object") {
    return Object.values(value).map(textOf).join(" ");
  }
  return String(value ?? "");
}

function sportOf(event) {
  const text = [
    event.title,
    event.slug,
    event.description,
    event.category,
    event.subcategory,
    event.sport,
    textOf(event.tags),
    textOf(event.series)
  ].join(" ").toLowerCase();

  if (
    /\b(cricket|ipl|t20|odi|test match|wpl|big bash|county cricket|ranji|cpl|psl|ashes)\b/.test(text)
  ) return "cricket";

  if (
    /\b(tennis|atp|wta|challenger|grand slam|wimbledon|roland garros|us open tennis|australian open tennis)\b/.test(text)
  ) return "tennis";

  if (
    /\b(football|soccer|premier league|champions league|europa league|la liga|serie a|bundesliga|ligue 1|mls|fifa|uefa|world cup qualifiers|fa cup|copa america|eredivisie)\b/.test(text)
  ) return "football";

  return null;
}

function isExcluded(event) {
  const title = String(event.title || "").toLowerCase();
  const slug = String(event.slug || "").toLowerCase();
  const text = title + " " + slug;

  if (event.active === false || event.closed === true) return true;

  if (/\b(election|president|congress|senate|bitcoin|ethereum|crypto|stock|nasdaq|s&p 500|fomc|interest rate|fed decision|ballon d'or|ballon dor)\b/.test(text)) {
    return true;
  }

  if (/\b(champion|winner of the tournament|season winner|league winner|to win the league|outright|top scorer|relegated|promotion)\b/.test(text)) {
    return true;
  }

  return false;
}

function isMatchEvent(event) {
  const title = String(event.title || "").trim();

  // Require a head-to-head style matchup.
  return /\b(vs\.?|versus|v\.)\b| @ /.test(title);
}

function getMarkets(event) {
  let markets = parseJSON(event.markets, []);

  if (!markets.length && Array.isArray(event.markets)) {
    markets = event.markets;
  }

  return markets;
}

function getTokenIds(market) {
  let ids = parseJSON(
    market.clobTokenIds ??
    market.clob_token_ids ??
    market.tokenIds ??
    market.tokens,
    []
  );

  if (!ids.length && Array.isArray(market.tokens)) {
    ids = market.tokens.map(token =>
      typeof token === "object"
        ? token.token_id || token.tokenId || token.id
        : token
    );
  }

  return ids.map(id => {
    if (id && typeof id === "object") {
      return String(id.token_id || id.tokenId || id.id || "");
    }
    return String(id || "");
  }).filter(Boolean);
}

function getOutcomes(market) {
  return parseJSON(market.outcomes, []);
}

function chooseWinnerMarket(event) {
  const markets = getMarkets(event);

  const usable = markets.filter(market => {
    const ids = getTokenIds(market);
    const outcomes = getOutcomes(market);
    return (
      market.active !== false &&
      market.closed !== true &&
      ids.length >= 2 &&
      outcomes.length >= 2
    );
  });

  if (!usable.length) return null;

  const winnerPattern = /\b(match winner|moneyline|to win|winner|who will win|winning team)\b/i;

  return (
    usable.find(market =>
      winnerPattern.test(
        String(market.question || market.groupItemTitle || "")
      )
    ) || usable[0]
  );
}

function normalizeEvent(event) {
  const sport = sportOf(event);
  if (!sport || isExcluded(event) || !isMatchEvent(event)) return null;

  const market = chooseWinnerMarket(event);
  if (!market) return null;

  const tokenIds = getTokenIds(market);
  const outcomes = getOutcomes(market);

  const outcomeTokens = outcomes.map((outcome, index) => ({
    name: String(outcome),
    tokenId: tokenIds[index] || null
  }));

  return {
    id: String(event.id || ""),
    title: String(event.title || ""),
    slug: String(event.slug || ""),
    sport,
    startDate: event.startDate || event.startDateIso || null,
    endDate: event.endDate || null,
    active: event.active !== false,
    closed: event.closed === true,
    url: event.slug
      ? "https://polymarket.com/event/" + event.slug
      : null,
    image: event.image || event.icon || null,
    marketId: String(market.id || ""),
    marketQuestion: String(market.question || event.title || ""),
    outcomes: outcomeTokens,
    tokenIds,
    marketSlug: market.slug || null
  };
}

function matchesWindow(event, windowName) {
  if (!windowName || windowName === "all" || windowName === "upcoming") {
    return true;
  }

  const start = event.startDate ? Date.parse(event.startDate) : NaN;
  if (!Number.isFinite(start)) return windowName !== "live";

  const now = Date.now();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const afterTomorrow = new Date(tomorrow);
  afterTomorrow.setDate(afterTomorrow.getDate() + 1);

  if (windowName === "live") {
    return start <= now && now - start < 8 * 60 * 60 * 1000;
  }

  if (windowName === "today") {
    return start >= today.getTime() && start < tomorrow.getTime();
  }

  if (windowName === "tomorrow") {
    return start >= tomorrow.getTime() && start < afterTomorrow.getTime();
  }

  if (windowName === "upcoming") {
    return start >= now;
  }

  return true;
}

async function fetchGammaPage(offset, limit = 100) {
  const url = new URL(GAMMA + "/events");
  url.searchParams.set("active", "true");
  url.searchParams.set("closed", "false");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("order", "startDate");
  url.searchParams.set("ascending", "true");

  const response = await fetch(url.toString(), {
    headers: { Accept: "application/json" }
  });

  if (!response.ok) {
    throw new Error("Gamma API returned HTTP " + response.status);
  }

  const data = await response.json();
  return Array.isArray(data) ? data : [];
}

async function fetchEvents(query) {
  const q = String(query.q || "").trim().toLowerCase();
  const requestedSport = String(query.sport || "all").toLowerCase();
  const windowName = String(query.window || "all").toLowerCase();

  if (requestedSport !== "all" && !SPORTS.includes(requestedSport)) {
    throw new Error("Unsupported sport. Use cricket, tennis, football or all.");
  }

  // Scan more pages for a search query than for the default listing.
  const maxPages = q ? 30 : 10;
  const pageSize = 100;
  const all = [];
  const seen = new Set();
  let pagesScanned = 0;

  // Fetch pages in small batches to reduce rate-limit risk.
  for (let offset = 0; offset < maxPages * pageSize; offset += pageSize * 3) {
    const offsets = [
      offset,
      offset + pageSize,
      offset + pageSize * 2
    ].filter(n => n < maxPages * pageSize);

    const results = await Promise.all(
      offsets.map(n =>
        fetchGammaPage(n, pageSize).catch(() => [])
      )
    );

    pagesScanned += results.length;

    let foundAny = false;

    for (const page of results) {
      if (page.length) foundAny = true;

      for (const event of page) {
        const id = String(event.id || event.slug || "");
        if (!id || seen.has(id)) continue;
        seen.add(id);
        all.push(event);
      }
    }

    if (!foundAny || results.some(page => page.length < pageSize)) {
      break;
    }
  }

  const normalized = all
    .map(normalizeEvent)
    .filter(Boolean)
    .filter(event =>
      requestedSport === "all" || event.sport === requestedSport
    )
    .filter(event => q ? true : matchesWindow(event, windowName))
    .filter(event => {
      if (!q) return true;

      const haystack = [
        event.title,
        event.slug,
        event.marketQuestion,
        event.sport
      ].join(" ").toLowerCase();

      return q.split(/\s+/).every(term => haystack.includes(term));
    });

  normalized.sort((a, b) => {
    const at = Date.parse(a.startDate || "") || 0;
    const bt = Date.parse(b.startDate || "") || 0;
    return at - bt;
  });

  return {
    success: true,
    source: "Polymarket Gamma",
    sport: requestedSport,
    query: q || null,
    count: normalized.length,
    pagesScanned,
    eventsScanned: all.length,
    matches: normalized.slice(0, q ? 100 : 60)
  };
}

async function fetchEventById(id) {
  if (!id) return json({ success: false, error: "Missing event id" }, 400);

  const url = new URL(GAMMA + "/events");
  url.searchParams.set("id", id);

  const response = await fetch(url.toString(), {
    headers: { Accept: "application/json" }
  });

  if (!response.ok) {
    return json({
      success: false,
      error: "Gamma API returned HTTP " + response.status
    }, 502);
  }

  const data = await response.json();
  const event = Array.isArray(data) ? data[0] : data;

  if (!event) {
    return json({ success: false, error: "Event not found" }, 404);
  }

  const markets = getMarkets(event).map(market => ({
    id: String(market.id || ""),
    question: market.question || "",
    slug: market.slug || null,
    active: market.active !== false,
    closed: market.closed === true,
    outcomes: getOutcomes(market),
    tokenIds: getTokenIds(market)
  }));

  return json({
    success: true,
    id: String(event.id || id),
    title: event.title || "",
    slug: event.slug || "",
    url: event.slug
      ? "https://polymarket.com/event/" + event.slug
      : null,
    markets
  });
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (request.method !== "GET") {
      return json({ success: false, error: "GET only" }, 405);
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      if (path === "/" || path === "/health") {
        return json({
          success: true,
          status: "ok",
          worker: "crystal-edge-polymarket",
          source: "Polymarket Gamma",
          allowedSports: SPORTS,
          endpoints: [
            "/health",
            "/matches?sport=all",
            "/matches?sport=cricket",
            "/matches?sport=tennis",
            "/matches?sport=football",
            "/matches?sport=all&q=India",
            "/event?id=EVENT_ID"
          ]
        });
      }

      if (path === "/matches" || path === "/sports") {
        const result = await fetchEvents({
          sport: url.searchParams.get("sport") || "all",
          window: url.searchParams.get("window") || "all",
          q: url.searchParams.get("q") || ""
        });

        return json(result);
      }

      if (path === "/events") {
        const result = await fetchEvents({
          sport: url.searchParams.get("sport") || "all",
          window: url.searchParams.get("window") || "all",
          q: url.searchParams.get("q") || ""
        });

        return json(result);
      }

      if (path === "/event") {
        return await fetchEventById(url.searchParams.get("id"));
      }

      return json({
        success: false,
        error: "Unknown endpoint",
        available: ["/health", "/matches", "/events", "/event?id=EVENT_ID"]
      }, 404);
    } catch (error) {
      return json({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error"
      }, 500);
    }
  }
};

