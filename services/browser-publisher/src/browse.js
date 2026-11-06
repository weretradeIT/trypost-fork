/**
 * Generic browse session for the browser-publisher bridge.
 *
 * WHY THIS EXISTS
 *   The organic engine (createAlignedBrowser) already produces a fully
 *   aligned, residential-egress, human-behaved Chromium session — but it was
 *   only reachable through /publish and /warmup. The free-sample ordering
 *   workflow needs a *generic* browser: open a page, snapshot, click, type,
 *   evaluate JS, screenshot — with the SAME fingerprint the publishers use.
 *
 *   This module gives that workflow a stateful session API (one HTTP request
 *   per action) so an orchestrator can drive a form fill across many calls
 *   without holding a Playwright handle of its own.
 *
 * SECURITY
 *   - Reuses the bridge's BRIDGE_SECRET auth (the route is registered behind
 *     the same timing-safe bearer middleware in server.js).
 *   - Egress is enforced by createAlignedBrowser (assertEgressAllowed,
 *     fail-closed) — browse traffic can NOT leave from a datacenter IP.
 *   - Every action is rate-limited (see browseLimiter in rate-limiter.js).
 *   - Sessions are capped (max concurrent + idle TTL) so a misbehaving
 *     client can't pin the browser fleet.
 *   - `evaluate` is the escape hatch; it is the caller's responsibility to
 *     pass a bounded expression. There is no sandbox here — the session
 *     already has full page access by design (that's what browsing is).
 *
 * API (all POST, JSON body, bearer auth):
 *   /browse/session      { url?, platform? }          -> { sessionId }
 *   /browse/navigate     { sessionId, url }           -> { url, title }
 *   /browse/snapshot     { sessionId }                -> { text }  (accessibility tree)
 *   /browse/click        { sessionId, selector }      -> { url, title }
 *   /browse/type         { sessionId, selector, text }-> { ok }
 *   /browse/evaluate     { sessionId, expression }    -> { result }
 *   /browse/screenshot   { sessionId }                -> { dataUrl }
 *   /browse/wait_for_selector { sessionId, selector, state?, timeout? } -> { ok, state }
 *   /browse/close        { sessionId }                -> { closed }
 *   /browse/sessions     {}                           -> { sessions: [...] }
 */

import { createAlignedBrowser } from './organic/browser.js';
import {
  humanPause,
  humanMouseMove,
  humanClick,
  humanScroll,
  humanBezierClick,
  humanNativeType,
  humanPreWarm,
  humanRelaySensorEvents,
  humanNativeMouseMove,
  withTimeout,
} from './organic/behavior.js';
import { ORGANIC_CONFIG } from './organic/config.js';

// --- Session registry --------------------------------------------------------
const sessions = new Map(); // sessionId -> { id, browser, context, page, platform, createdAt, lastUsed, alive }

const MAX_CONCURRENT = parseInt(process.env.BROWSE_MAX_CONCURRENT || '4', 10);
// WAVE A: session TTL — ORGANIC_SESSION_TTL_MINUTES (compose) or BROWSE_IDLE_TTL_MS (direct).
const SESSION_TTL_MS = process.env.BROWSE_IDLE_TTL_MS
  ? parseInt(process.env.BROWSE_IDLE_TTL_MS, 10)
  : parseInt(process.env.ORGANIC_SESSION_TTL_MINUTES || '15', 10) * 60_000;
const IDLE_TTL_MS = parseInt(SESSION_TTL_MS, 10);
const NAV_TIMEOUT_MS = parseInt(process.env.BROWSE_NAV_TIMEOUT_MS || '45_000'.replace('_', ''), 10);
// WAVE A: wait_for_selector timeout (ms)
const WAIT_FOR_SELECTOR_TIMEOUT_MS = parseInt(process.env.ORGANIC_WAIT_FOR_SELECTOR_TIMEOUT_MS || '15000', 10);

function now() { return Date.now(); }

function isIdle(s) { return now() - s.lastUsed > IDLE_TTL_MS; }

// --- Hot Standby Pool for instantaneous session creation (<50ms) -------------
const standbyPool = new Map(); // platform -> { promise, createdAt }

async function createRawSession(platform) {
  const { browser, context, close, userAgent, platform: pKey } = await createAlignedBrowser({ platform });
  const page = await context.newPage();
  return { browser, context, page, close, userAgent, pKey, createdAt: Date.now() };
}

export function replenishStandby(platform = 'linkedin') {
  if (activeCount() >= MAX_CONCURRENT) return;
  if (!standbyPool.has(platform)) {
    const promise = createRawSession(platform).catch((err) => {
      standbyPool.delete(platform);
      console.warn(`[StandbyPool] Failed to warm standby session for ${platform}: ${err.message}`);
      return null;
    });
    standbyPool.set(platform, { promise, createdAt: Date.now() });
  }
}

export async function drainStandbyPool() {
  for (const [platform, item] of standbyPool) {
    standbyPool.delete(platform);
    try {
      const raw = await item.promise;
      if (raw) await raw.close().catch(() => {});
    } catch (_) {}
  }
}

function evictIdle() {
  for (const [id, s] of sessions) {
    if (!s.alive || isIdle(s)) {
      sessions.delete(id);
      s.close().catch(() => {});
    }
  }
  // Check if any standby session has aged out (> 15 min)
  for (const [platform, item] of standbyPool) {
    if (Date.now() - item.createdAt > IDLE_TTL_MS) {
      standbyPool.delete(platform);
      item.promise.then((raw) => { if (raw) raw.close().catch(() => {}); }).catch(() => {});
    }
  }
}
// Periodic reaper — never let dead browsers leak.
const reaper = setInterval(evictIdle, 60_000).unref?.();

function activeCount() {
  let n = 0;
  for (const s of sessions.values()) if (s.alive) n++;
  return n;
}

function requireSession(sessionId) {
  const s = sessions.get(String(sessionId || ''));
  if (!s || !s.alive) {
    const err = new Error('browse session not found or closed');
    err.status = 404;
    throw err;
  }
  s.lastUsed = now();
  return s;
}

// --- Action helpers ----------------------------------------------------------
async function waitForLoad(page) {
  // Be tolerant: networkidle can hang on chatty pages; domcontentloaded is the
  // floor. We wait for domcontentloaded, then a short settle for JS forms.
  await page.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT_MS }).catch(() => {});
  await humanPause(); // log-normal 0.8–2.5s — lets form JS + consent banners mount
}

/**
 * Open (or reuse) a session. `url` is optional — a session can start blank and
 * be navigated later. `platform` selects the aligned identity: 'linkedin'
 * (macOS Chrome) or 'x' (Windows Chrome). Default 'linkedin' for DE sites.
 * Uses the pre-warmed standby pool for instant sub-50ms session starts.
 */
export async function browseSession({ url, platform = 'linkedin' } = {}) {
  if (activeCount() >= MAX_CONCURRENT) {
    const err = new Error(`browse concurrency limit reached (${MAX_CONCURRENT})`);
    err.status = 429;
    throw err;
  }

  let raw = null;
  if (standbyPool.has(platform)) {
    const item = standbyPool.get(platform);
    standbyPool.delete(platform);
    raw = await item.promise;
    // Replenish in the background for the next caller
    setTimeout(() => replenishStandby(platform), 100);
  }

  if (!raw || !raw.page || raw.page.isClosed()) {
    raw = await createRawSession(platform);
  }

  const { browser, context, page, close, userAgent, pKey } = raw;
  const id = `bs_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;

  const s = {
    id, browser, context, page,
    platform: pKey, userAgent,
    createdAt: now(), lastUsed: now(),
    alive: true, lastError: null,
    close: async () => {
      s.alive = false;
      await page.close().catch(() => {});
      await close();
      replenishStandby(pKey);
    },
  };

  // Console + crash diagnostics: a page crash is the #1 way sessions die
  // silently (we hit this with PEN4YOU). Surface it on the session.
  page.on('crash', () => { s.alive = false; s.lastError = 'page crashed'; });
  page.on('pageerror', (e) => { s.lastError = `pageerror: ${e.message}`; });

  sessions.set(id, s);

  if (url) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }).catch((e) => {
      s.lastError = `initial goto: ${e.message}`;
    });
    await waitForLoad(page);
  }

  return {
    sessionId: id,
    platform: pKey,
    url: page.url(),
    title: await page.title().catch(() => ''),
    lastError: s.lastError,
  };
}

export async function browseNavigate({ sessionId, url }) {
  const s = requireSession(sessionId);
  if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    const err = new Error('navigate requires an http(s) url');
    err.status = 400;
    throw err;
  }
  await s.page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  await waitForLoad(s.page);
  return { url: s.page.url(), title: await s.page.title().catch(() => ''), lastError: s.lastError };
}

export async function browseSnapshot({ sessionId }) {
  const s = requireSession(sessionId);
  // Playwright >= 1.49 removed page.accessibility(). Build a compact,
  // interactive-element snapshot from the DOM instead — this is what an
  // orchestrator actually needs to drive a form (selectors + labels + state).
  const lines = [];
  try {
    const data = await s.page.evaluate(() => {
      const out = [];
      const sel = 'a, button, input, select, textarea, label[for], [role="button"], [role="link"], [onclick]';
      const els = document.querySelectorAll(sel);
      const cap = (t) => (t || '').replace(/\s+/g, ' ').trim().slice(0, 100);
      els.forEach((el, i) => {
        const tag = el.tagName.toLowerCase();
        const type = el.type ? `:${el.type}` : '';
        const id = el.id ? ` #${el.id}` : '';
        // Build a selector: prefer id, else name, else nth-of-type path.
        let sel;
        if (el.id) sel = `#${CSS.escape(el.id)}`;
        else if (el.name) sel = `${tag}[name="${el.name}"]`;
        else sel = `${tag}[data-bi="${i}"]`;
        const label = cap(el.getAttribute('aria-label') || el.placeholder || el.title || el.value || (el.textContent || '').slice(0, 60));
        const checked = el.checked !== undefined ? (el.checked ? ' [checked]' : '') : '';
        const disabled = el.disabled ? ' [disabled]' : '';
        const href = el.href ? ` href="${cap(el.href, 80)}"` : '';
        out.push({ i, tag: `${tag}${type}`, sel, label, checked, disabled, href, value: tag === 'input' ? cap(el.value) : '' });
      });
      return {
        title: document.title,
        url: location.href,
        formCount: document.querySelectorAll('form').length,
        forms: [...document.querySelectorAll('form')].map((f) => ({
          action: cap(f.action, 80), method: (f.method || 'get').toUpperCase(),
          inputs: f.querySelectorAll('input,select,textarea').length,
        })),
        elements: out,
      };
    });
    lines.push(`URL: ${data.url}`);
    lines.push(`Title: ${data.title}`);
    lines.push(`Forms: ${data.formCount}` + (data.forms.length ? ` ${JSON.stringify(data.forms)}` : ''));
    lines.push('');
    lines.push('Interactive elements:');
    for (const el of data.elements) {
      lines.push(`  [${el.i}] ${el.tag}${el.id ? '' : ''} ${el.sel} ${el.label ? `"${el.label}"` : ''}${el.checked}${el.disabled}${el.href}`);
    }
  } catch (e) {
    lines.push(`snapshot error: ${e.message}`);
  }
  const text = lines.join('\n');
  return { text, chars: text.length, lastError: s.lastError };
}

// Frame-targeted interactions: resolve the main page or the matching frame.
// Supports substring matching on frame URL, exact/substring on frame name,
// case-insensitive matching, and detailed error messages with available frames.
// Prioritizes child iframes over main frame when frameUrl is provided.
export function resolveFrameTarget(s, frameUrl) {
  if (!frameUrl) return s.page;
  const target = String(frameUrl).trim();
  if (!target) return s.page;

  const allFrames = s.page.frames();
  const mainFrame = s.page.mainFrame();
  const childFrames = allFrames.filter(fr => fr !== mainFrame);

  // When a frameUrl is specified, search child iframes first so host pages
  // sharing domain substrings (e.g. google.com/recaptcha) don't mask iframes.
  const searchPool = [...childFrames, mainFrame];

  // 1. Exact match on URL or frame name
  let f = searchPool.find(fr => fr.url() === target || fr.name() === target);
  if (f) return f;

  // 2. Substring match on URL
  f = searchPool.find(fr => fr.url() && fr.url().includes(target));
  if (f) return f;

  // 3. Substring match on frame name
  f = searchPool.find(fr => fr.name() && fr.name().includes(target));
  if (f) return f;

  // 4. StartsWith match (for legacy callers)
  f = searchPool.find(fr => fr.url() && fr.url().startsWith(target));
  if (f) return f;

  // 5. Case-insensitive substring match
  const lower = target.toLowerCase();
  f = searchPool.find(fr => (fr.url() && fr.url().toLowerCase().includes(lower)) ||
                            (fr.name() && fr.name().toLowerCase().includes(lower)));
  if (f) return f;

  const available = allFrames.map(fr => ({ name: fr.name(), url: fr.url() }));
  const e = new Error(`frame not found for target "${target}". Available frames (${allFrames.length}): ${JSON.stringify(available)}`);
  e.status = 404;
  throw e;
}

export async function browseClick({ sessionId, selector, frameUrl, force = false } = {}) {
  const s = requireSession(sessionId);
  if (!selector) { const e = new Error('click requires a selector'); e.status = 400; throw e; }

  // Clean up blocking modal backdrop overlays if present
  await s.page.evaluate(() => {
    const blocking = ['#cmpbox2', '#cmpbox', '.cmpboxBG', '.modal-backdrop', '#platinum_country_modal', '.country-modal-backdrop'];
    for (const sel of blocking) {
      const el = document.querySelector(sel);
      if (el) el.remove();
    }
  }).catch(() => {});

  const target = resolveFrameTarget(s, frameUrl);
  const isFrameTarget = target !== s.page;
  // Human-ish: move to the element, small pre-pause, click (main page only).
  const el = await target.$(selector);
  if (el && !isFrameTarget) {
    await humanMouseMove(target, el).catch(() => {});
  }
  // WAVE A: use configurable click timeout
  const clickTimeout = parseInt(process.env.ORGANIC_CLICK_TIMEOUT_MS || '30000', 10);
  try {
    // For iframe targets, force=true by default so parent overlays don't block
    await target.click(selector, {
      timeout: isFrameTarget ? 5000 : clickTimeout,
      force: force || isFrameTarget,
    });
  } catch (err) {
    // If intercepted by an overlay/backdrop or pointer-events check, retry with force: true
    if (/intercepts pointer events/i.test(err.message) && !force) {
      await target.click(selector, { timeout: 10000, force: true });
    } else {
      throw err;
    }
  }
  await s.page.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT_MS }).catch(() => {});
  return { url: s.page.url(), title: await s.page.title().catch(() => ''), lastError: s.lastError };
}

export async function browseWaitForSelector({ sessionId, selector, state = 'visible', timeout = WAIT_FOR_SELECTOR_TIMEOUT_MS, frameUrl } = {}) {
  const s = requireSession(sessionId);
  const target = resolveFrameTarget(s, frameUrl);
  if (!selector) { const e = new Error('wait_for_selector requires a selector'); e.status = 400; throw e; }
  const validStates = ['attached', 'detached', 'visible', 'hidden'];
  if (!validStates.includes(state)) {
    const e = new Error(`invalid state: ${state}. must be one of ${validStates.join(', ')}`);
    e.status = 400;
    throw e;
  }
  try {
    await target.waitForSelector(selector, { state, timeout });
    return { ok: true, state, lastError: s.lastError };
  } catch (e) {
    const err = new Error(`wait_for_selector timeout: ${e.message}`);
    err.status = 408;
    err.lastError = e.message;
    throw err;
  }
}

export async function browseType({ sessionId, selector, text, frameUrl } = {}) {
  const s = requireSession(sessionId);
  if (!selector || text == null) { const e = new Error('type requires selector and text'); e.status = 400; throw e; }
  const target = resolveFrameTarget(s, frameUrl);
  const clickTimeout = parseInt(process.env.ORGANIC_CLICK_TIMEOUT_MS || '30000', 10);
  await target.click(selector, { timeout: clickTimeout }).catch(() => {}); // focus
  try {
    await target.fill(selector, String(text));
  } catch (fillErr) {
    if (/Input of type "(radio|checkbox)" cannot be filled/i.test(fillErr.message)) {
      await target.check(selector).catch(() => target.click(selector));
    } else {
      throw fillErr;
    }
  }
  return { ok: true, lastError: s.lastError };
}

export async function browseEvaluate({ sessionId, expression, frameUrl } = {}) {
  const s = requireSession(sessionId);
  if (!expression) { const e = new Error('evaluate requires an expression'); e.status = 400; throw e; }
  const target = resolveFrameTarget(s, frameUrl);
  const result = await target.evaluate(expression);
  return { result: result === undefined ? null : result, lastError: s.lastError };
}

export async function browseFrames({ sessionId } = {}) {
  const s = requireSession(sessionId);
  const frames = s.page.frames().map((f, i) => ({
    index: i,
    name: f.name() || '',
    url: f.url() || '',
    isDetached: f.isDetached(),
    parent: f.parentFrame() ? f.parentFrame().url() : null,
  }));
  return { frames, count: frames.length, lastError: s.lastError };
}

export async function browseScreenshot({ sessionId }) {
  const s = requireSession(sessionId);
  const buf = await s.page.screenshot({ type: 'png', fullPage: false });
  const dataUrl = `data:image/png;base64,${buf.toString('base64')}`;
  return { dataUrl, bytes: buf.length, lastError: s.lastError };
}

export async function browseScroll({ sessionId, steps = 3 } = {}) {
  const s = requireSession(sessionId);
  await humanScroll(s.page, { steps }).catch(() => {});
  return { ok: true, lastError: s.lastError };
}

export async function browseClose({ sessionId }) {
  const s = sessions.get(String(sessionId || ''));
  if (!s) return { closed: false };
  sessions.delete(s.id);
  await s.close().catch(() => {});
  return { closed: true };
}

export function browseSessions() {
  const list = [...sessions.values()].map((s) => ({
    sessionId: s.id,
    platform: s.platform,
    url: s.page.url(),
    alive: s.alive,
    idleMs: now() - s.lastUsed,
    createdAt: s.createdAt,
    lastError: s.lastError,
  }));
  return { active: activeCount(), maxConcurrent: MAX_CONCURRENT, sessions: list };
}

// --- Anti-bot v2 endpoints (Bézier click, native type, pre-warm) -------------
// These use the native-event primitives from behavior.js that produce
// isTrusted=true pointer and keyboard events, defeating Arkose Labs /
// Cloudflare Turnstile heuristics.

/**
 * Human-like click via cubic Bézier cursor path + native mouse down/up.
 * Every mousemove, mousedown, mouseup event is isTrusted=true.
 * Falls back to Playwright's standard click on selector-resolve failure.
 */
export async function browseHumanClick({ sessionId, selector, frameUrl } = {}) {
  const s = requireSession(sessionId);
  if (!selector) { const e = new Error('human_click requires a selector'); e.status = 400; throw e; }

  // Clean up blocking modal backdrop overlays if present
  await s.page.evaluate(() => {
    const blockingSelectors = ['#cmpbox2', '#cmpbox', '.cmpboxBG', '.modal-backdrop', '#platinum_country_modal', '.country-modal-backdrop'];
    for (const sel of blockingSelectors) {
      const el = document.querySelector(sel);
      if (el) el.remove();
    }
  }).catch(() => {});

  const target = resolveFrameTarget(s, frameUrl);
  try {
    await humanBezierClick(target, selector);
  } catch (err) {
    if (target !== s.page) {
      await target.click(selector, { timeout: 10000, force: true });
    } else {
      throw err;
    }
  }
  await s.page.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT_MS }).catch(() => {});
  return { url: s.page.url(), title: await s.page.title().catch(() => ''), lastError: s.lastError };
}

/**
 * Human-like typing via native keyboard.press() with QWERTZ bi-gram latency,
 * log-normal jitter, and occasional typo+correction. Focuses the element first
 * via Bézier click. Every keydown/keypress/input/keyup event is isTrusted=true.
 */
export async function browseHumanType({ sessionId, selector, text, frameUrl, typoProbability } = {}) {
  const s = requireSession(sessionId);
  if (!selector || text == null) { const e = new Error('human_type requires selector and text'); e.status = 400; throw e; }

  // Clean up blocking modal backdrop overlays if present
  await s.page.evaluate(() => {
    const blockingSelectors = ['#cmpbox2', '#cmpbox', '.cmpboxBG', '.modal-backdrop', '#platinum_country_modal', '.country-modal-backdrop'];
    for (const sel of blockingSelectors) {
      const el = document.querySelector(sel);
      if (el) el.remove();
    }
  }).catch(() => {});

  const target = resolveFrameTarget(s, frameUrl);
  try {
    await humanNativeType(target, selector, String(text), {
      typoProbability: typoProbability != null ? Number(typoProbability) : undefined,
    });
  } catch (_) {
    await target.fill(selector, String(text));
  }
  return { ok: true, lastError: s.lastError };
}

/**
 * Session pre-warming: ambient mouse drift, scroll events, and focus signals
 * to establish a human session fingerprint before high-value interactions.
 * Defends against time-to-first-interaction detection (bots <500ms, humans 2-8s).
 */
export async function browsePreWarm({ sessionId, durationMs = 3000 } = {}) {
  const s = requireSession(sessionId);
  const budget = Math.max(1000, Math.min(10000, Number(durationMs) || 3000));
  await withTimeout(humanPreWarm(s.page, budget), budget + 6000, 'browsePreWarm').catch((e) => {
    s.lastError = `preWarm: ${e.message}`;
  });
  return { ok: true, durationMs: budget, lastError: s.lastError };
}

/**
 * Native wheel-based scroll with human-like increments and pauses.
 * Uses page.mouse.wheel() for isTrusted=true wheel events.
 */
export async function browseHumanScroll({ sessionId, deltaY = 300, steps = 4 } = {}) {
  const s = requireSession(sessionId);
  const totalDelta = Math.max(50, Math.min(2000, Number(deltaY) || 300));
  const numSteps = Math.max(2, Math.min(12, Number(steps) || 4));
  const perStep = Math.round(totalDelta / numSteps);
  for (let i = 0; i < numSteps; i++) {
    // Slightly varied step size for human-like rhythm.
    const jitteredDelta = perStep + (Math.random() - 0.5) * perStep * 0.3;
    await withTimeout(s.page.mouse.wheel(0, jitteredDelta), 3000, 'humanScroll wheel').catch(() => {});
    await humanPause(200, 800);
  }
  return { ok: true, scrolled: totalDelta, steps: numSteps, lastError: s.lastError };
}

/**
 * Move the native mouse pointer directly to an (x, y) coordinate.
 * Produces real isTrusted=true pointer events on the page.
 */
export async function browseNativeMouseMove({ sessionId, x, y } = {}) {
  const s = requireSession(sessionId);
  const cursor = await humanNativeMouseMove(s.page, x, y);
  return { ok: true, cursor, lastError: s.lastError };
}

/**
 * Discover PerimeterX / HUMAN Security sensor iframes on the page,
 * and dispatch native mouse movements across their area so the
 * in-frame telemetry collector receives authentic isTrusted=true events.
 */
export async function browseRelaySensorEvents({ sessionId } = {}) {
  const s = requireSession(sessionId);
  const result = await humanRelaySensorEvents(s.page);
  return { ok: true, ...result, lastError: s.lastError };
}

/**
 * Check PerimeterX and DFP token readiness on the current page.
 * Returns the state of _px3, _pxde, _pxvid, dfpStatus, and window.__pxTokens.
 */
export async function browsePxTokenStatus({ sessionId } = {}) {
  const s = requireSession(sessionId);
  const result = await s.page.evaluate(() => {
    // 1. Read tokens intercepted from postMessage stream
    const pxTokens = window.__pxTokens || {};

    // 2. Fall back to document.cookie
    const cookies = document.cookie || '';
    const getCookie = (name) => {
      const match = cookies.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
      return match ? match[1] : null;
    };

    const px3 = pxTokens.px3 || getCookie('_px3');
    const pxde = pxTokens.pxde || getCookie('_pxde');
    const pxvid = pxTokens.pxvid || getCookie('_pxvid');
    const dfpStatus = pxTokens.dfpStatus || null;

    // Check for __px global (PerimeterX client state)
    const hasPxGlobal = typeof window.__px !== 'undefined';

    // Check for HUMAN Security sensor iframe
    const sensorIframe = document.querySelector(
      'iframe[id*="HumanSensor"], iframe[id*="iHumanSensor"], ' +
      'iframe[src*="hsprotect.net"]'
    );
    const sensorPresent = !!sensorIframe;

    let mutablePx3 = null;
    try {
      if (window._px3 || window.mutablePx3) {
        mutablePx3 = window._px3 || window.mutablePx3;
      }
    } catch (_) {}

    return {
      px3: px3 ? px3.slice(0, 80) + '...' : null,
      pxde: pxde ? pxde.slice(0, 80) + '...' : null,
      pxvid: pxvid || null,
      dfpStatus: dfpStatus || null,
      dfpReady: dfpStatus === 'dfp:OK' || (typeof dfpStatus === 'string' && dfpStatus.includes('OK')),
      px3Present: !!px3 && px3.length > 10,
      pxdePresent: !!pxde && pxde.length > 10,
      pxvidPresent: !!pxvid && pxvid.length > 10,
      hasPxGlobal,
      sensorPresent,
      mutablePx3: mutablePx3 ? String(mutablePx3).slice(0, 40) : null,
      allTokensReady: !!px3 && px3.length > 10 && !!pxde && pxde.length > 10 && !!pxvid,
      cookieString: cookies.slice(0, 300),
    };
  }).catch((e) => ({
    error: e.message,
    allTokensReady: false,
    px3Present: false,
    pxdePresent: false,
    pxvidPresent: false,
  }));

  return { ok: true, ...result, lastError: s.lastError };
}

export {
  evictIdle as browseEvictIdle,
  activeCount as browseActiveCount,
  replenishStandby as browseReplenishStandby,
  drainStandbyPool as browseDrainStandbyPool,
};
