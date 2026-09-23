/**
 * CamoFox tab keep-alive — Wave B.
 *
 * WHY THIS EXISTS
 *   The CamoFox server (camofox-browser container, lair404:9377) runs a
 *   per-tab inactivity reaper:
 *
 *       setInterval(() => {
 *         ... if (tabState.toolCalls === tabState._lastReaperToolCalls) {
 *               if (idleMs >= TAB_INACTIVITY_MS) { safePageClose(tabState.page); ... }
 *       }, 60_000);
 *
 *   Defaults (lib/config.js): TAB_INACTIVITY_MS = 300000 (5 min),
 *   SESSION_TIMEOUT_MS = 600000 (10 min). Every successful tab-level API call
 *   (evaluate/click/type/...) increments tabState.toolCalls and resets the
 *   idle clock. So an orchestrator that thinks/polls for >5 min between tab
 *   calls (e.g. waiting on email, LLM round-trips) gets its tab silently
 *   reaped — the next evaluate returns 404 "tab not found" and any in-page
 *   form state (Svelte island selections, hidden-field sync) is gone with it.
 *
 *   Evidence (server logs 2026-09-22): ~15 occurrences of
 *   `tab reaped (inactive) ... idleMs:300000` for w1408-bob-* sample runs,
 *   each followed by the orchestrator's 404 burst.
 *
 *   NOTE: the reaper is SERVER-SIDE. A client-side in-page timer cannot
 *   defeat it (no tool call = dead), and page unload kills it anyway. The
 *   only correct fix is a CLIENT-SIDE (Node) ping loop that issues a cheap
 *   tab API call at a cadence well under TAB_INACTIVITY_MS.
 *
 * DEFAULTS: ping every 10 s (spec). Each ping is a single synchronous
 *   evaluate of a no-op expression (~1 ms server-side, increments toolCalls).
 *
 * USAGE:
 *   const { KeepAlive } = await import('./camofox-keepalive.js');
 *   const ka = new KeepAlive({
 *     request: (path, body) => camofox._request(path, body), // or fetch
 *     tabId, userId,
 *     intervalMs: 10_000,
 *     log: console.log,
 *   });
 *   ka.start();
 *   ... run form flow, LLM thinking, email waits ...
 *   ka.stop();           // always stop on close/error
 *   await ka.close();    // = stop()
 */

const DEFAULT_INTERVAL_MS = 10_000;

/** A deliberately cheap, synchronous, side-effect-free in-page ping. */
export const PING_EXPRESSION =
  '(function(){ window.__cf_ka = (window.__cf_ka || 0) + 1; return "ka:" + window.__cf_ka; })()';

export class KeepAlive {
  /**
   * @param {object} opts
   * @param {string} opts.tabId            CamoFox tab id
   * @param {string} opts.userId           CamoFox userId
   * @param {(method: string, path: string, body?: object) => Promise<object>} opts.request
   *        Pre-bound HTTP transport for this server (mirrors CamofoxSession._request
   *        so Bearer auth, error handling, and JSON parsing all come for free).
   * @param {number} [opts.intervalMs=10000] Ping cadence. Must stay < TAB_INACTIVITY_MS (300 s).
   * @param {number} [opts.maxConsecutiveFailures=3] Stop + report after N failed pings
   *        (a failed ping means the tab/session is already gone — pinging forever is pointless).
   * @param {Function} [opts.log]
   * @param {Function} [opts.onDead] Called once when the tab is judged dead.
   */
  constructor({ tabId, userId, request, intervalMs = DEFAULT_INTERVAL_MS, maxConsecutiveFailures = 3, log = () => {}, onDead }) {
    if (!tabId || !request) throw new Error('KeepAlive requires tabId + request');
    this.tabId = tabId;
    this.userId = userId || '';
    this.request = request;
    this.intervalMs = Math.max(1_000, Math.min(intervalMs, 60_000));
    this.maxConsecutiveFailures = maxConsecutiveFailures;
    this.log = log;
    this.onDead = onDead;
    this.timer = null;
    this.dead = false;
    this.pings = 0;
    this.failures = 0;
    this.lastPingAt = 0;
    this._stopGuard = false;
  }

  get running() { return this.timer !== null; }

  start() {
    if (this.timer || this.dead) return this;
    // Fire immediately (resets the clock right now), then on the cadence.
    this._tick();
    this.timer = setInterval(() => {
      // If the previous ping is still in flight (slow network), skip — never overlap.
      if (this._inFlight) return;
      this._tick();
    }, this.intervalMs);
    // Never let the timer keep the process alive.
    if (this.timer.unref) this.timer.unref();
    return this;
  }

  async _tick() {
    if (this.dead || this._stopGuard) return;
    this._inFlight = true;
    const t0 = Date.now();
    try {
      await this.request('POST', `/tabs/${this.tabId}/evaluate`, {
        userId: this.userId,
        expression: PING_EXPRESSION,
      });
      this.failures = 0;
      this.pings += 1;
      this.lastPingAt = Date.now();
      this.log(`[keepalive] ping#${this.pings} ok (${Date.now() - t0} ms)`);
    } catch (err) {
      this.failures += 1;
      this.log(`[keepalive] ping#${this.pings + 1} FAILED (${this.failures}/${this.maxConsecutiveFailures}): ${err.message}`);
      if (this.failures >= this.maxConsecutiveFailures) {
        this.dead = true;
        this._stop();
        if (this.onDead) {
          try { this.onDead({ tabId: this.tabId, error: err.message, pings: this.pings }); }
          catch { /* onDead must never break the loop */ }
        }
      }
    } finally {
      this._inFlight = false;
    }
  }

  _stop() {
    this._stopGuard = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** Stop pinging (keeps the tab alive only if the caller keeps its own calls going). */
  stop() { this._stop(); return this.dead; }

  async close() { this.stop(); return this; }

  /** Diagnostic snapshot for status endpoints / logs. */
  status() {
    return {
      tabId: this.tabId,
      running: this.running,
      dead: this.dead,
      pings: this.pings,
      failures: this.failures,
      intervalMs: this.intervalMs,
      lastPingMs: this.lastPingAt ? Date.now() - this.lastPingAt : null,
    };
  }
}

export default KeepAlive;
