
/* CRYSTAL EDGE — Browser Web Worker
   Public Gamma event discovery + public Polymarket CLOB market feed.
   No API keys, trading, fabricated odds, or third-party odds server.
*/
'use strict';

const GAMMA = 'https://gamma-api.polymarket.com/events';
const CLOB_WS = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const PAGE_SIZE = 100;
const MAX_PAGES = 20;
const ALLOWED = new Set(['cricket', 'tennis', 'soccer', 'basketball']);

let socket = null;
let reconnectTimer = null;
let heartbeat = null;
let reconnectDelay = 1500;
let loading = false;
let packetCount = 0;
let lastFetchMs = null;

let matches = [];
const quotes = new Map();
const tokenOwners = new Map();
const subscribed = new Set();

function send(type, data = {}) {
  self.postMessage({ type, ...data });
}

function array(value) {
  if (Array.isArray(value)) return value;
  try {
    const result = JSON.parse(value || '[]');
    return Array.isArray(result) ? result : [];
  } catch {
    return [];
  }
}

function clean(value) {
  return String(value ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function sportOf(event) {
  const tags = Array.isArray(event.tags)
    ? event.tags.map(t => typeof t === 'string' ? t : `${t.label || ''} ${t.slug || ''} ${t.name || ''}`).join(' ')
    : '';

  const text = `${tags} ${event.sport || ''} ${event.category || ''} ${event.title || ''} ${event.slug || ''} ${event.description || ''}`.toLowerCase();

  if (/\b(cricket|ipl|t20|odi|ashes|big bash|test match)\b/.test(text)) return 'cricket';
  if (/\b(tennis|atp|wta|challenger|wimbledon|roland garros|us open|australian open)\b/.test(text)) return 'tennis';
  if (/\b(basketball|nba|wnba|euroleague|ncaa basketball)\b/.test(text)) return 'basketball';
  if (/\b(soccer|football|premier league|champions league|la liga|serie a|bundesliga|ligue 1|mls|fifa|uefa)\b/.test(text)) return 'soccer';

  return null;
}

function isMatchTitle(title) {
  if (!title) return false;

  if (/\b(winner of|champion|outright|ballon d'or|mvp|election|president|fomc|bitcoin|ethereum|s&p 500|stock price)\b/i.test(title)) {
    return false;
  }

  return /\b(vs?\.?|versus)\b/i.test(title);
}

function getTokens(market) {
  let tokens = array(market.clobTokenIds || market.clob_token_ids || market.tokenIds);

  if (!tokens.length && Array.isArray(market.tokens)) {
    tokens = market.tokens.map(t => t.token_id || t.tokenId || t.id);
  }

  return tokens.map(String).filter(Boolean);
}

function getOutcomes(market) {
  const outcomes = array(market.outcomes);
  if (outcomes.length) return outcomes.map(clean);

  if (Array.isArray(market.tokens)) {
    return market.tokens.map(t => clean(t.outcome || t.name));
  }

  return [];
}

function validMarket(market) {
  return market &&
    market.active !== false &&
    market.closed !== true &&
    getTokens(market).length >= 2;
}

function decimalPrice(price) {
  const p = Number(price);
  return Number.isFinite(p) && p > 0 && p < 1 ? (1 / p).toFixed(2) : null;
}

function parseDate(event) {
  const raw = event.startTime || event.startDate || event.gameStartTime || event.eventDate;
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function buildMatches(events) {
  const result = [];

  for (const event of events) {
    const sport = sportOf(event);
    const title = clean(event.title || event.question || '');

    if (!sport || !ALLOWED.has(sport) || !isMatchTitle(title)) continue;

    const markets = (Array.isArray(event.markets) ? event.markets : [])
      .filter(validMarket)
      .map(market => ({
        question: clean(market.question || market.groupItemTitle || title),
        tokens: getTokens(market),
        outcomes: getOutcomes(market),
        quotes: []
      }));

    if (!markets.length) continue;

    const first = markets[0];
    const id = String(event.id || event.slug || title);

    result.push({
      id,
      title,
      sport,
      date: parseDate(event),
      live: Boolean(event.live || event.isLive),
      url: event.slug ? `https://polymarket.com/event/${event.slug}` : '',
      question: first.question,
      token: first.tokens[0],
      outcomes: first.outcomes,
      markets,
      quote: {}
    });
  }

  return result;
}

function publishMatches() {
  const output = matches.map(match => {
    const marketOutput = match.markets.map(market => ({
      question: market.question,
      tokens: market.tokens,
      outcomes: market.outcomes,
      quotes: market.tokens.map(token => quotes.get(token) || {})
    }));

    const firstToken = match.token;
    return {
      ...match,
      quote: quotes.get(firstToken) || {},
      markets: marketOutput
    };
  });

  send('matches', { matches: output });
}

async function refresh() {
  if (loading) return;
  loading = true;
  const started = performance.now();

  send('status', { text: 'Fetching public Polymarket events…' });

  try {
    const events = [];

    for (let page = 0; page < MAX_PAGES; page++) {
      const url = `${GAMMA}?active=true&closed=false&limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`;

      const response = await fetch(url, {
        headers: { accept: 'application/json' }
      });

      if (!response.ok) throw new Error(`Gamma HTTP ${response.status}`);

      const batch = await response.json();
      if (!Array.isArray(batch) || batch.length === 0) break;

      events.push(...batch);

      if (batch.length < PAGE_SIZE) break;
    }

    lastFetchMs = Math.round(performance.now() - started);
    matches = buildMatches(events);

    // Keep existing quotes for tokens still in the active match set.
    tokenOwners.clear();

    for (const match of matches) {
      for (const market of match.markets) {
        for (const token of market.tokens) {
          if (!tokenOwners.has(token)) tokenOwners.set(token, match.id);
        }
      }
    }

    const needed = new Set(tokenOwners.keys());
    for (const token of [...quotes.keys()]) {
      if (!needed.has(token)) quotes.delete(token);
    }

    send('stats', {
      events: events.length,
      matches: matches.length,
      packets: packetCount,
      latency: lastFetchMs
    });

    publishMatches();
    connectSocket();
    syncSubscriptions();
  } catch (error) {
    send('error', { message: error?.message || 'Unknown Gamma error' });
  } finally {
    loading = false;
  }
}

function connectSocket() {
  if (socket && (
    socket.readyState === WebSocket.OPEN ||
    socket.readyState === WebSocket.CONNECTING
  )) return;

  try {
    socket = new WebSocket(CLOB_WS);

    socket.addEventListener('open', () => {
      reconnectDelay = 1500;
      send('conn', { connected: true });

      // Subscribe to active tokens in manageable batches.
      syncSubscriptions();

      clearInterval(heartbeat);
      heartbeat = setInterval(() => {
        if (socket?.readyState === WebSocket.OPEN) socket.send('PING');
      }, 10000);
    });

    socket.addEventListener('message', event => {
      if (event.data === 'PONG' || event.data === 'pong') return;

      packetCount++;

      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }

      const list = Array.isArray(message) ? message : [message];
      let changed = false;

      for (const item of list) {
        if (!item || typeof item !== 'object') continue;

        if (item.event_type === 'book' || (item.bids && item.asks)) {
          const token = String(item.asset_id || item.assetId || '');
          if (!tokenOwners.has(token)) continue;

          const bids = Array.isArray(item.bids) ? item.bids : [];
          const asks = Array.isArray(item.asks) ? item.asks : [];

          const bid = bids.map(x => Number(x.price))
            .filter(x => x > 0 && x < 1)
            .sort((a, b) => b - a)[0] ?? null;

          const ask = asks.map(x => Number(x.price))
            .filter(x => x > 0 && x < 1)
            .sort((a, b) => a - b)[0] ?? null;

          quotes.set(token, { bid, ask, at: Date.now() });
          changed = true;
        }

        if (item.event_type === 'best_bid_ask') {
          const token = String(item.asset_id || '');
          if (!tokenOwners.has(token)) continue;

          const bid = Number(item.best_bid);
          const ask = Number(item.best_ask);

          quotes.set(token, {
            bid: Number.isFinite(bid) && bid > 0 && bid < 1 ? bid : null,
            ask: Number.isFinite(ask) && ask > 0 && ask < 1 ? ask : null,
            at: Date.now()
          });

          changed = true;
        }

        if (item.event_type === 'price_change' && Array.isArray(item.price_changes)) {
          for (const change of item.price_changes) {
            const token = String(change.asset_id || '');
            if (!tokenOwners.has(token)) continue;

            const previous = quotes.get(token) || {};
            const bid = Number(change.best_bid);
            const ask = Number(change.best_ask);

            quotes.set(token, {
              bid: Number.isFinite(bid) && bid > 0 && bid < 1
                ? bid : (previous.bid ?? null),
              ask: Number.isFinite(ask) && ask > 0 && ask < 1
                ? ask : (previous.ask ?? null),
              at: Date.now()
            });

            changed = true;
          }
        }
      }

      if (changed) {
        publishMatches();
        send('stats', {
          events: undefined,
          matches: matches.length,
          packets: packetCount,
          latency: lastFetchMs
        });
      }
    });

    socket.addEventListener('close', () => {
      clearInterval(heartbeat);
      send('conn', { connected: false });

      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        connectSocket();
      }, reconnectDelay);

      reconnectDelay = Math.min(reconnectDelay * 2, 15000);
    });

    socket.addEventListener('error', () => {
      try { socket.close(); } catch {}
    });
  } catch (error) {
    send('conn', { connected: false });
    send('error', { message: error?.message || 'WebSocket connection failed' });
  }
}

function syncSubscriptions() {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;

  const tokens = [...tokenOwners.keys()];
  const newTokens = tokens.filter(token => !subscribed.has(token));

  for (let i = 0; i < newTokens.length; i += 100) {
    const batch = newTokens.slice(i, i + 100);

    socket.send(JSON.stringify({
      type: 'market',
      assets_ids: batch,
      custom_feature_enabled: true
    }));

    batch.forEach(token => subscribed.add(token));
  }

  const wanted = new Set(tokens);
  const removed = [...subscribed].filter(token => !wanted.has(token));

  for (let i = 0; i < removed.length; i += 100) {
    const batch = removed.slice(i, i + 100);

    socket.send(JSON.stringify({
      assets_ids: batch,
      operation: 'unsubscribe',
      type: 'market'
    }));

    batch.forEach(token => subscribed.delete(token));
  }
}

self.addEventListener('message', event => {
  if (event.data?.cmd === 'refresh') refresh();
});

// Initial data load.
refresh();
