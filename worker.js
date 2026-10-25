/* --------------------------------------------------------------
   worker.js – Polymorphic odds worker (fixed for Cloudflare Workers)
   --------------------------------------------------------------
   • No async work at the top level – everything is inside event
     handlers (WebSocket events, message events, etc.).
   • Counts every packet, measures latency, and forwards only the
     three allowed sports.
   • Sends three message types to the main thread:
        {type:'odds', …}          – filtered odds for the UI
        {type:'stats', latency, packets}
        {type:'conn', connected:true/false}
   -------------------------------------------------------------- */

const allowedSports = new Set(['cricket', 'soccer', 'tennis']);
const WS_URL = 'wss://crystal-live-odds.mbeta3996.workers.dev'; // <-- replace if you have a different endpoint

let socket = null;               // the Polymorphic WebSocket
let pendingRequests = 0;         // how many fetch‑requests are waiting
let packetCounter = 0;           // total packets received (incl. filtered)
let lastLatency = null;          // ms – updated after each fetch response

/* -----------------------------------------------------------------
   Helper: open (or reopen) the Polymorphic WebSocket
   ----------------------------------------------------------------- */
function openSocket() {
  // If we already have an open socket, do nothing.
  if (socket && socket.readyState === WebSocket.OPEN) return;

  // ----------------------------------------------------------------
  // Create the socket – this is *synchronous* (just the constructor)
  // ----------------------------------------------------------------
  socket = new WebSocket(WS_URL);

  // ----------------------------------------------------------------
  // WebSocket event listeners – all async work lives here
  // ----------------------------------------------------------------
  socket.addEventListener('open', () => {
    // Tell the UI we are connected
    self.postMessage({type: 'conn', connected: true});

    // If a fetch was requested while we were offline, send it now.
    if (pendingRequests > 0) {
      pendingRequests--;
      sendFetchRequest();               // defined below
    }
  });

  socket.addEventListener('message', ev => {
    // Count *every* packet (including the ones we will later filter)
    packetCounter++;

    try {
      const raw = JSON.parse(ev.data);

      // ----------------------------------------------------------------
      // 1️⃣ Fetch‑response handling – the server replies with a wrapper
      // ----------------------------------------------------------------
      if (raw.cmd === 'fetchResponse') {
        const now = performance.now();
        const latency = Math.round(now - raw.startTime);
        lastLatency = latency;

        // Send stats back to the UI
        self.postMessage({
          type: 'stats',
          latency,
          packets: packetCounter
        });
        return; // do not forward this as an odds message
      }

      // ----------------------------------------------------------------
      // 2️⃣ Normal odds message – filter by sport
      // ----------------------------------------------------------------
      if (!raw.sport || !allowedSports.has(raw.sport)) return; // ignore other sports

      const payload = {
        type: 'odds',
        sport: raw.sport,
        home: raw.home,
        away: raw.away,
        homeOdds: raw.homeOdds,
        awayOdds: raw.awayOdds
      };
      self.postMessage(payload);
    } catch (e) {
      console.warn('[worker] ignored malformed message', ev.data);
    }
  });

  socket.addEventListener('close', () => {
    // Notify UI that we are disconnected
    self.postMessage({type: 'conn', connected: false});
    // Simple back‑off – you can make this exponential if you like
    setTimeout(openSocket, 5000);
  });

  socket.addEventListener('error', err => {
    console.error('[worker] WebSocket error', err);
    socket.close(); // will trigger the 'close' handler above
  });
}

/* -----------------------------------------------------------------
   Helper: send a fetch request to the worker endpoint.
   The request payload must contain a `startTime` (performance.now())
   so we can compute latency when the server replies.
   ----------------------------------------------------------------- */
function sendFetchRequest() {
  // Record the time *before* we send the request.
  const startTime = performance.now();

  // The payload we send – the server expects a `cmd: 'fetch'` and the startTime.
  const payload = JSON.stringify({cmd: 'fetch', startTime});

  // The socket may still be CONNECTING; `socket.readyState` can be 0 (CONNECTING)
  // but `socket.send` works fine – the server will associate the response
  // with the `startTime` we supplied.
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(payload);
  } else {
    // If the socket isn’t open yet, the `open` handler will call this again.
    pendingRequests++;
  }
}

/* -----------------------------------------------------------------
   Listen for commands from the main thread (index.html)
   ----------------------------------------------------------------- */
self.addEventListener('message', ev => {
  const cmd = ev.data?.cmd;
  if (cmd === 'fetch') {
    // Increment the counter *before* we send the request.
    pendingRequests++;
    sendFetchRequest();
  }
});

/* -----------------------------------------------------------------
   Kick‑off – open the socket as soon as the worker starts.
   ----------------------------------------------------------------- */
openSocket();