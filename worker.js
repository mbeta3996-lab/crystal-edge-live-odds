const GAMMA = "https://gamma-api.polymarket.com";
const ALLOWED_SPORTS = ["cricket", "tennis", "soccer"];
const PAGE_SIZE = 100;
const MAX_PAGES_PER_SPORT = 12;
const CACHE_TTL_MS = 60000;
const CACHE = new Map();

const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: HEADERS
  });
}

function norm(v) {
  return String(v ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[’']/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function arr(v) {
  if (Array.isArray(v)) return v;
  if (typeof v !== "string") return [];
  try {
    const x = JSON.parse(v);
    return Array.isArray(x) ? x : [];
  } catch {
    return [];
  }
}

function isOpen(m) {
  return !!m &&
    m.active !== false &&
    m.closed !== true &&
    m.archived !== true &&
    m.acceptingOrders !== false &&
    m.enableOrderBook !== false;
}

function tokenIds(m) {
  const ids = arr(m?.clobTokenIds)
    .map(x => String(x ?? "").trim())
    .filter(Boolean);

  if (ids.length) return [...new Set(ids)];

  return [...new Set(
    arr(m?.tokens)
      .map(t => String(
        t?.token_id ?? t?.tokenId ?? t?.asset_id ?? ""
      ).trim())
      .filter(Boolean)
  )];
}

function outcomes(m) {
  return arr(m?.outcomes).map(o =>
    typeof o === "string"
      ? o
      : String(o?.name ?? o?.outcome ?? "")
  );
}

function eventText(e) {
  const tags = arr(e?.tags).map(t =>
    typeof t === "string"
      ? t
      : [t?.label, t?.slug, t?.name]
          .filter(Boolean).join(" ")
  );

  return norm([
    e?.title,
    e?.slug,
    e?.description,
    e?.ticker,
    e?.series?.title,
    ...tags
  ].filter(Boolean).join(" "));
}

function sportOf(e) {
  const t = eventText(e);

  if (/\b(bitcoin|ethereum|crypto|s&p 500|nasdaq|dow jones|gold price|election|fomc|federal reserve|interest rate|ballon d'or|ballon dor|top scorer award|league winner|season winner|outright)\b/.test(t)) {
    return null;
  }

  if (/\b(cricket|ipl|t20|odi|test match|big bash|bbl|psl|cpl|the hundred|ranji trophy|wpl|ashes)\b/.test(t)) {
    return "cricket";
  }

  if (/\b(tennis|atp|wta|grand slam|wimbledon|roland garros|french open|us open|australian open|challenger)\b/.test(t)) {
    return "tennis";
  }

  if (/\b(soccer|football|premier league|champions league|europa league|la liga|serie a|bundesliga|ligue 1|mls|fa cup|world cup|epl|uefa|fifa|eredivisie|copa)\b/.test(t)) {
    return "soccer";
  }

  return null;
}

function isMatchTitle(title) {
  const t = norm(title);

  if (!t) return false;

  if (/\b(outright|champion|championship winner|league winner|season winner|top scorer|relegat|qualify for|tournament winner|mvp|award|price target)\b/.test(t)) {
    return false;
  }

  return /\b(vs\.?|v\.?|versus)\b/.test(t);
}

function winnerMarket(m, eventTitle) {
  if (!isOpen(m)) return false;

  const q = norm(
    m?.question ?? m?.groupItemTitle ?? m?.title ?? ""
  );

  const excluded = /\b(total corners?|corners?|over\/under|over or under|o\/u|totals?|both teams to score|double chance|handicap|spread|player props?|shots?|cards?|yellow cards?|red cards?|sets? handicap|games? handicap|total games?|total sets?|aces|break points|first half|half time|correct score|winning margin|race to|team total|runs? total|wickets?|sixes|fours?|top scorer|anytime scorer|first goal|next goal|penalt(y|ies)|to qualify|tournament winner|series winner|set winner|period winner|quarter winner)\b/;

  if (excluded.test(q)) return false;

  const ids = tokenIds(m);
  const outs = outcomes(m).map(norm);

  if (ids.length !== 2 || outs.length !== 2) return false;
  if (outs.includes("yes") || outs.includes("no")) return false;

  const winnerWords =
    /\b(winner|to win|win the match|match winner|moneyline|match result|result of the match)\b/.test(q);

  const neutral =
    !q ||
    q === norm(eventTitle) ||
    /\b(vs\.?|v\.?|versus)\b/.test(q);

  return winnerWords || neutral;
}

function normaliseMarket(m, e) {
  const ids = tokenIds(m);
  const names = outcomes(m);

  if (ids.length !== 2 || names.length !== 2) return null;

  return {
    id: String(m.id ?? ""),
    question: String(
      m.question ?? m.groupItemTitle ?? e.title ?? "Match winner"
    ),
    outcomes: names,
    clobTokenIds: ids,
    tokens: ids.map((id, i) => ({
      id,
      name: names[i] || `Outcome ${i + 1}`
    })),
    marketUrl: m.slug && e.slug
      ? `https://polymarket.com/event/${e.slug}/${m.slug}`
      : e.slug
        ? `https://polymarket.com/event/${e.slug}`
        : null
  };
}

function eventSummary(e) {
  const sport = sportOf(e);
  const title = String(e.title ?? e.question ?? "");

  if (
    !sport ||
    !isMatchTitle(title) ||
    e.active === false ||
    e.closed === true ||
    e.archived === true
  ) {
    return null;
  }

  const markets = arr(e.markets)
    .filter(m => winnerMarket(m, title))
    .map(m => normaliseMarket(m, e))
    .filter(Boolean);

  if (!markets.length) return null;

  const primary = markets[0];
  const now = Date.now();
  const start = Date.parse(e.startDate ?? e.start_date ?? "");
  const end = Date.parse(e.endDate ?? e.end_date ?? "");

  const live =
    e.live === true ||
    e.isLive === true ||
    /^(inprogress|in_progress|live|break|halftime)$/i.test(
      String(e.status ?? "")
    );

  if (Number.isFinite(end) && end < now) return null;

  if (
    Number.isFinite(start) &&
    start < now - 36 * 60 * 60 * 1000 &&
    !live &&
    (!Number.isFinite(end) || end < now)
  ) {
    return null;
  }

  return {
    id: String(e.id ?? e.slug ?? ""),
    eventId: String(e.id ?? ""),
    title,
    slug: String(e.slug ?? ""),
    sport,
    startDate: e.startDate ?? e.start_date ?? null,
    endDate: e.endDate ?? e.end_date ?? null,
    active: e.active !== false,
    closed: e.closed === true,
    live,
    status: e.status ?? null,
    eventUrl: e.slug
      ? `https://polymarket.com/event/${e.slug}`
      : null,
    marketQuestion: primary.question,
    marketId: primary.id,
    marketUrl: primary.marketUrl,
    tokens: primary.tokens,
    clobTokenIds: primary.clobTokenIds,
    outcomes: primary.outcomes,
    marketCount: 1,
    fancyMarkets: [],
    updatedAt: new Date().toISOString()
  };
}

async function fetchPage(offset, sport) {
  const u = new URL(`${GAMMA}/events`);

  u.searchParams.set("active", "true");
  u.searchParams.set("closed", "false");
  u.searchParams.set("limit", String(PAGE_SIZE));
  u.searchParams.set("offset", String(offset));
  u.searchParams.set("order", "startDate");
  u.searchParams.set("ascending", "false");
  u.searchParams.set("tag_slug", sport);
  u.searchParams.set("include_tag", "true");

  const response = await fetch(u.toString(), {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(9000)
  });

  if (!response.ok) {
    throw new Error(
      `Gamma HTTP ${response.status} (${sport}, offset ${offset})`
    );
  }

  const data = await response.json();
  return Array.isArray(data) ? data : [];
}

async function scan(sportFilter = "all") {
  const sports =
    sportFilter === "all"
      ? ALLOWED_SPORTS
      : [sportFilter];

  const jobs = [];

  for (const sport of sports) {
    for (
      let page = 0;
      page < MAX_PAGES_PER_SPORT;
      page++
    ) {
      jobs.push({
        sport,
        offset: page * PAGE_SIZE
      });
    }
  }

  const results = new Array(jobs.length);
  let nextJob = 0;

  async function runner() {
    while (true) {
      const index = nextJob++;

      if (index >= jobs.length) return;

      const job = jobs[index];

      try {
        results[index] = {
          ok: true,
          data: await fetchPage(
            job.offset,
            job.sport
          )
        };
      } catch (error) {
        results[index] = {
          ok: false,
          error: String(
            error?.message ?? error
          )
        };
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(3, jobs.length) },
      () => runner()
    )
  );

  const raw = new Map();
  const errors = [];

  results.forEach((result, index) => {
    if (result?.ok) {
      for (const event of result.data) {
        if (event?.id != null) {
          raw.set(String(event.id), event);
        }
      }
    } else {
      errors.push({
        sport: jobs[index].sport,
        offset: jobs[index].offset,
        error:
          result?.error ?? "Unknown fetch error"
      });
    }
  });

  const unique = new Map();

  for (const event of raw.values()) {
    const row = eventSummary(event);

    if (
      row &&
      (
        sportFilter === "all" ||
        row.sport === sportFilter
      )
    ) {
      unique.set(row.id, row);
    }
  }

  const data = [...unique.values()].sort(
    (a, b) =>
      (Date.parse(a.startDate) || Infinity) -
      (Date.parse(b.startDate) || Infinity)
  );

  return {
    data,
    scannedEvents: raw.size,
    uniqueEvents: raw.size,
    errors,
    fetchedAt: new Date().toISOString()
  };
}

async function getData(
  force = false,
  sport = "all"
) {
  let entry = CACHE.get(sport);

  if (!entry) {
    entry = {
      at: 0,
      value: null,
      pending: null
    };

    CACHE.set(sport, entry);
  }

  if (
    !force &&
    entry.value &&
    Date.now() - entry.at < CACHE_TTL_MS
  ) {
    return entry.value;
  }

  if (entry.pending) {
    return entry.pending;
  }

  entry.pending = scan(sport)
    .then(value => {
      entry.value = value;
      entry.at = Date.now();
      return value;
    })
    .finally(() => {
      entry.pending = null;
    });

  return entry.pending;
}

async function fetchEvent(id) {
  const response = await fetch(
    `${GAMMA}/events/${encodeURIComponent(id)}`,
    {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(9000)
    }
  );

  if (!response.ok) {
    throw new Error(`Gamma HTTP ${response.status}`);
  }

  return await response.json();
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method.toUpperCase();

    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: HEADERS
      });
    }

    if (method !== "GET") {
      return json({
        success: false,
        error: "Method not allowed"
      }, 405);
    }

    try {
      if (path === "/" || path === "/health") {
        return json({
          success: true,
          status: "ok",
          worker: "crystal-live-odds",
          source: "Polymarket Gamma events + public CLOB",
          allowedSports: ALLOWED_SPORTS,
          pageSize: PAGE_SIZE,
          maxPagesPerSport: MAX_PAGES_PER_SPORT,
          endpoints: [
            "/health",
            "/sports",
            "/matches?sport=all&limit=100&offset=0",
            "/events?sport=all&limit=100&offset=0",
            "/event?id=EVENT_ID"
          ]
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
            error: "Missing event id"
          }, 400);
        }

        const event = await fetchEvent(id);
        const data = eventSummary(event);

        return json({
          success: true,
          data
        });
      }

      if (path === "/matches" || path === "/events") {
        let sport = (
          url.searchParams.get("sport") || "all"
        ).toLowerCase();

        if (sport === "football") {
          sport = "soccer";
        }

        if (
          sport !== "all" &&
          !ALLOWED_SPORTS.includes(sport)
        ) {
          return json({
            success: false,
            error: "Unsupported sport",
            allowedSports: ALLOWED_SPORTS
          }, 400);
        }

        const limit = Math.min(
          100,
          Math.max(
            1,
            Number.parseInt(
              url.searchParams.get("limit") || "100",
              10
            ) || 100
          )
        );

        const offset = Math.max(
          0,
          Number.parseInt(
            url.searchParams.get("offset") || "0",
            10
          ) || 0
        );

        const force =
          url.searchParams.get("refresh") === "1";

        const result = await getData(force, sport);
        const data = result.data;

        return json({
          success: true,
          worker: "crystal-live-odds",
          source: "Polymarket Gamma",
          sport,
          count: data.length,
          totalFoundInScannedPages: data.length,
          scannedEvents: result.scannedEvents,
          uniqueEvents: result.uniqueEvents,
          limit,
          offset,
          hasMore: offset + limit < data.length,
          fetchedAt: result.fetchedAt,
          errors: result.errors,
          data: data.slice(offset, offset + limit)
        });
      }

      return json({
        success: false,
        error: "Not found",
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
        error: String(
          error?.message ?? error
        )
      }, 502);
    }
  }
};