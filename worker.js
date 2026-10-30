const GAMMA = "https://gamma-api.polymarket.com";

const ALLOWED_SPORTS = ["cricket", "tennis", "soccer"];
const PAGE_SIZE = 100;
const MAX_PAGES_PER_SPORT = 12;
const CACHE_TTL_MS = 12000;

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

function truthyOpen(m) {
  return (
    m &&
    m.active !== false &&
    m.closed !== true &&
    m.archived !== true &&
    m.acceptingOrders !== false &&
    m.enableOrderBook !== false
  );
}

function tokenIds(m) {
  const ids = arr(m?.clobTokenIds)
    .map(x => String(x ?? "").trim())
    .filter(Boolean);

  if (ids.length) return [...new Set(ids)];

  return [
    ...new Set(
      arr(m?.tokens)
        .map(t =>
          String(
            t?.token_id ??
            t?.tokenId ??
            t?.asset_id ??
            ""
          ).trim()
        )
        .filter(Boolean)
    )
  ];
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
      : [t?.label, t?.slug, t?.name].filter(Boolean).join(" ")
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

  if (
    /\b(bitcoin|ethereum|crypto|s&p 500|nasdaq|dow jones|gold price|election|fomc|federal reserve|interest rate|ballon d'or|ballon dor|top scorer award|league winner|season winner|outright)\b/.test(t)
  ) {
    return null;
  }

  if (
    /\b(cricket|ipl|t20|odi|test match|big bash|bbl|psl|cpl|the hundred|ranji trophy|wpl|ashes)\b/.test(t)
  ) {
    return "cricket";
  }

  if (
    /\b(tennis|atp|wta|grand slam|wimbledon|roland garros|french open|us open|australian open|challenger)\b/.test(t)
  ) {
    return "tennis";
  }

  if (
    /\b(soccer|football|premier league|champions league|europa league|la liga|serie a|bundesliga|ligue 1|mls|fa cup|world cup|epl|uefa|fifa|eredivisie|copa)\b/.test(t)
  ) {
    return "soccer";
  }

  return null;
}

  function matchupTitle(title) {
  const t = norm(title);

  if (/\b(outright|champion|championship winner|league winner|season winner)\b/.test(t)) {
    return false;
  }

  return /\b(vs\.?|v\.?|versus)\b/i.test(t);
}
function marketKind(m, eventTitle) {
  const q = norm(
    m?.question ??
    m?.groupItemTitle ??
    m?.title ??
    ""
  );

  const event = norm(eventTitle);

  const excluded =
    /\b(toss|set\s*\d*|first set|second set|third set|fourth set|fifth set|game winner|total games|total sets|handicap|spread|over\/under|over or under|total corners?|corners?|both teams to score|double chance|correct score|winning margin|race to|team total|runs total|wickets?|sixes|fours|top scorer|anytime scorer|first goal|next goal|penalt(y|ies)|to qualify|tournament winner|series winner|match goes to day)\b/;

  if (excluded.test(q)) return null;

  const outs = outcomes(m).map(x => norm(x));
  const ids = tokenIds(m);

  if (ids.length < 2 || !truthyOpen(m)) return null;
  if (outs.length < 2) return null;

  const isFootballThreeWay =
    String(m?.sportsMarketType || "").toLowerCase() === "moneyline" &&
    String(m?.marketMetadata?.opticOddsMarketId || "").toLowerCase() === "moneyline_3-way" &&
    ["home", "draw", "away"].includes(
      String(m?.marketMetadata?.selectionLine || "").toLowerCase()
    );

  if (
    isFootballThreeWay &&
    outs.includes("yes") &&
    outs.includes("no")
  ) {
    return { kind: "winner", score: 20 };
  }

  if (outs.includes("yes") && outs.includes("no")) return null;

  const winnerWords =
    /\b(match winner|to win the match|wins? the match|match result|moneyline|winner of the match)\b/.test(q);

  const neutralMatchQuestion =
    q === event ||
    q === `${event} - more markets`;

  if (winnerWords || neutralMatchQuestion) {
    return {
      kind: "winner",
      score: winnerWords ? 10 : 8
    };
  }

  return null;
}
  // Do not accept ordinary Yes/No markets as match winners.
function normaliseMarket(m, event) {
  const ids = tokenIds(m);
  const names = outcomes(m);

  if (ids.length < 2 || names.length < 2) return null;

  const tokens = ids.map((id, i) => ({
    id,
    name: names[i] || `Outcome ${i + 1}`
  }));

  const question = String(
    m.question ??
    m.groupItemTitle ??
    event.title ??
    "Match winner"
  );

  return {
    id: String(m.id ?? ""),
    question,
    slug: m.slug ?? null,

    active: m.active !== false,
    closed: m.closed === true,

    acceptingOrders: m.acceptingOrders ?? null,
    enableOrderBook: m.enableOrderBook ?? null,

    outcomes: names,
    outcomePrices: arr(m.outcomePrices),
    clobTokenIds: ids,
    tokens,

    bestBid: m.bestBid ?? null,
    bestAsk: m.bestAsk ?? null,

    liquidity:
      Number(m.liquidityNum ?? m.liquidity ?? 0) || 0,

    volume:
      Number(m.volumeNum ?? m.volume ?? 0) || 0,

    marketUrl: m.slug
      ? `https://polymarket.com/event/${event.slug}/${m.slug}`
      : null
  };
}

function eventSummary(e) {
  const sport = sportOf(e);
  const title = String(e.title ?? e.question ?? "");

  if (
    !sport ||
    !matchupTitle(title) ||
    e.active === false ||
    e.closed === true ||
    e.archived === true
  ) {
    return null;
  }

  const rawMarkets = arr(e.markets);

  const ranked = rawMarkets
    .map(m => ({
      m,
      k: marketKind(m, title)
    }))
    .filter(x => x.k);

  ranked.sort(
    (a, b) =>
      b.k.score - a.k.score ||
      (
        Number(b.m.liquidityNum ?? b.m.liquidity ?? 0) -
        Number(a.m.liquidityNum ?? a.m.liquidity ?? 0)
      )
  );

  if (!ranked.length) return null;

  const primary = normaliseMarket(ranked[0].m, e);

  if (!primary) return null;

  const now = Date.now();

  const start = Date.parse(
    e.startDate ?? e.start_date ?? ""
  );

  const end = Date.parse(
    e.endDate ?? e.end_date ?? ""
  );

  const explicitLive =
    e.live === true ||
    e.isLive === true ||
    /^(inprogress|in_progress|live|break|halftime)$/i.test(
      String(e.status ?? "")
    );

  if (Number.isFinite(end) && end < now) return null;

  if (
    Number.isFinite(start) &&
    start < now - 36 * 60 * 60 * 1000 &&
    !explicitLive
  ) {
    return null;
  }

  const fancyMarkets = rawMarkets
    .map(m => normaliseMarket(m, e))
    .filter(Boolean)
    .filter(m => m.id !== primary.id)
    .slice(0, 30);

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

    live: explicitLive,
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

    marketCount: 1 + fancyMarkets.length,

    fancyMarkets: fancyMarkets.map(m => ({
      id: m.id,
      question: m.question,
      slug: m.slug,
      tokens: m.tokens,
      clobTokenIds: m.clobTokenIds,
      outcomes: m.outcomes,
      marketUrl: m.marketUrl
    })),

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
  u.searchParams.set(
  "ascending",
  sport === "soccer" ? "false" : "true"
);
 const tag = sport === "soccer" ? "soccer" : sport;

  u.searchParams.set("tag_slug", tag);
  u.searchParams.set("include_tag", "true");

  const r = await fetch(u.toString(), {
    headers: {
      Accept: "application/json"
    },
    cf: {
      cacheTtl: 0
    }
  });

  if (!r.ok) {
    throw new Error(
      `Gamma HTTP ${r.status} (${sport}, offset ${offset})`
    );
  }

  const d = await r.json();

  return Array.isArray(d) ? d : [];
}

/* -------------------------------------------------------
   NEW SCAN LOGIC
   Individual sports scan independently.
   Pages are fetched sequentially to reduce Worker load.
------------------------------------------------------- */

async function scan(requestedSport = "all") {
  const sports = requestedSport === "all"
    ? ALLOWED_SPORTS
    : [requestedSport];

  const raw = new Map();
  const errors = [];

  for (const sport of sports) {
    for (let p = 0; p < MAX_PAGES_PER_SPORT; p++) {
      const offset = p * PAGE_SIZE;

      try {
        const events = await fetchPage(offset, sport);

        for (const e of events) {
          if (e?.id != null) {
            raw.set(String(e.id), e);
          }
        }

        if (events.length < PAGE_SIZE) {
          break;
        }

      } catch (e) {
        errors.push({
          sport,
          offset,
          error: String(e?.message ?? e)
        });

        break;
      }
    }
  }

  const rows = [];

  for (const e of raw.values()) {
    const row = eventSummary(e);

    if (row) rows.push(row);
  }

  const unique = new Map(
    rows.map(x => [x.id, x])
  );

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

/* -------------------------------------------------------
   NEW SEPARATE CACHE PER SPORT
------------------------------------------------------- */

async function getData(force = false, requestedSport = "all") {
  const key = requestedSport;
  const now = Date.now();

  let entry = CACHE.get(key);

  if (!entry) {
    entry = {
      at: 0,
      value: null,
      pending: null
    };

    CACHE.set(key, entry);
  }

  if (
    !force &&
    entry.value &&
    now - entry.at < CACHE_TTL_MS
  ) {
    return entry.value;
  }

  if (!force && entry.pending) {
    return entry.pending;
  }

  entry.pending = scan(requestedSport)
    .then(result => {
      entry.value = result;
      entry.at = Date.now();
      return result;
    })
    .finally(() => {
      entry.pending = null;
    });

  return entry.pending;
}

async function fetchEvent(id) {
  const u = new URL(`${GAMMA}/events`);

  u.searchParams.set("id", id);

  const r = await fetch(u.toString(), {
    headers: {
      Accept: "application/json"
    }
  });

  if (!r.ok) {
    throw new Error(`Gamma HTTP ${r.status}`);
  }

  const d = await r.json();

  return Array.isArray(d)
    ? d.find(e => String(e.id) === id) ?? null
    : d;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const path =
      url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: HEADERS
      });
    }

    // VPS WebSocket relay
    if (path === "/ws") {
      if (
        request.headers.get("Upgrade")?.toLowerCase() !==
        "websocket"
      ) {
        return json({
          success: false,
          error: "WebSocket upgrade required"
        }, 426);
      }

      if (!env.BRIDGE_URL || !env.BRIDGE_TOKEN) {
        return json({
          success: false,
          error: "BRIDGE_URL or BRIDGE_TOKEN is not configured"
        }, 503);
      }

      try {
        const upstream = await fetch(env.BRIDGE_URL, {
          headers: {
            Upgrade: "websocket",
            Authorization: `Bearer ${env.BRIDGE_TOKEN}`
          }
        });

        if (
          upstream.status !== 101 ||
          !upstream.webSocket
        ) {
          return json({
            success: false,
            error: "VPS bridge rejected WebSocket",
            upstreamStatus: upstream.status
          }, 502);
        }

        const pair = new WebSocketPair();

        const client = pair[0];
        const server = pair[1];
        const remote = upstream.webSocket;

        server.accept();
        remote.accept();

        const relay = (from, to) => {
          from.addEventListener("message", event => {
            try {
              to.send(event.data);
            } catch {}
          });

          from.addEventListener("close", event => {
            try {
              to.close(
                event.code || 1000,
                event.reason || "closed"
              );
            } catch {}
          });

          from.addEventListener("error", () => {
            try {
              to.close(1011, "relay error");
            } catch {}
          });
        };

        relay(server, remote);
        relay(remote, server);

        return new Response(null, {
          status: 101,
          webSocket: client
        });

      } catch (e) {
        return json({
          success: false,
          error: "VPS WebSocket relay failed",
          details: String(e?.message ?? e)
        }, 502);
      }
    }

    if (request.method !== "GET") {
      return json({
        success: false,
        error: "GET only"
      }, 405);
    }

    try {
      if (path === "/" || path === "/health") {
        return json({
          success: true,
          status: "ok",
          worker: "crystal-live-odds",
          source: "Polymarket Gamma + authenticated VPS CLOB WebSocket relay",
          allowedSports: ALLOWED_SPORTS,
          pageSize: PAGE_SIZE,
          maxPagesPerSport: MAX_PAGES_PER_SPORT,
          scanMode: "sequential-per-sport",
          endpoints: [
            "/health",
            "/sports",
            "/matches?sport=all&limit=100&offset=0",
            "/event?id=EVENT_ID",
            "/ws"
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
            error: "Missing id"
          }, 400);
        }

        const e = await fetchEvent(id);
        const row = e ? eventSummary(e) : null;

        return row
          ? json({
              success: true,
              data: row
            })
          : json({
              success: false,
              error: "Eligible open head-to-head market not found"
            }, 404);
      }

      if (path === "/matches" || path === "/events") {
        const sportRaw = norm(
          url.searchParams.get("sport") || "all"
        );

        const sport =
          sportRaw === "football"
            ? "soccer"
            : sportRaw;

        if (
          sport !== "all" &&
          !ALLOWED_SPORTS.includes(sport)
        ) {
          return json({
            success: false,
            error: `Unsupported sport. Use all, ${ALLOWED_SPORTS.join(", ")}`,
            allowedSports: ALLOWED_SPORTS
          }, 400);
        }

        const limit = Math.min(
          200,
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

        // IMPORTANT: scan only the requested sport.
        const result = await getData(force, sport);

        const filtered = result.data.filter(
          x => sport === "all" || x.sport === sport
        );

        return json({
          success: true,
          worker: "crystal-live-odds",
          source: "Polymarket Gamma",
          sport,
          count: filtered.length,
          total: filtered.length,
          scannedEvents: result.scannedEvents,
          uniqueEvents: result.uniqueEvents,
          offset,
          limit,
          hasMore: offset + limit < filtered.length,
          fetchedAt: result.fetchedAt,
          scanErrors: result.errors.slice(0, 8),
          data: filtered.slice(offset, offset + limit)
        });
      }

      return json({
        success: false,
        error: "Not found",
        endpoints: [
          "/health",
          "/sports",
          "/matches",
          "/event"
        ]
      }, 404);

    } catch (e) {
      return json({
        success: false,
        error: String(e?.message ?? e),
        timestamp: new Date().toISOString()
      }, 502);
    }
  }
};