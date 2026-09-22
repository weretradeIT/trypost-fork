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
import { humanPause, humanMouseMove, humanClick, humanScroll } from './organic/behavior.js';
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

function evictIdle() {
  for (const [id, s] of sessions) {
    if (!s.alive || isIdle(s)) {
      sessions.delete(id);
      s.close().catch(() => {});
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
 */
export async function browseSession({ url, platform = 'linkedin' } = {}) {
  if (activeCount() >= MAX_CONCURRENT) {
    const err = new Error(`browse concurrency limit reached (${MAX_CONCURRENT})`);
    err.status = 429;
    throw err;
  }

  const { browser, context, close, userAgent, platform: pKey } = await createAlignedBrowser({ platform });
  const page = await context.newPage();
  const id = `bs_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;

  // Console + crash diagnostics: a page crash is the #1 way sessions die
  // silently (we hit this with PEN4YOU). Surface it on the session.
  page.on('crash', () => { s.alive = false; s.lastError = 'page crashed'; });
  page.on('pageerror', (e) => { s.lastError = `pageerror: ${e.message}`; });

  const s = {
    id, browser, context, page,
    platform: pKey, userAgent,
    createdAt: now(), lastUsed: now(),
    alive: true, lastError: null,
    close: async () => {
      s.alive = false;
      await page.close().catch(() => {});
      await close();
    },
  };
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

export async function browseClick({ sessionId, selector }) {
  const s = requireSession(sessionId);
  if (!selector) { const e = new Error('click requires a selector'); e.status = 400; throw e; }
  // Human-ish: move to the element, small pre-pause, click.
  const el = await s.page.$(selector);
  if (el) {
    await humanMouseMove(s.page, el).catch(() => {});
  }
  // WAVE A: use configurable click timeout
  const clickTimeout = parseInt(process.env.ORGANIC_CLICK_TIMEOUT_MS || '30000', 10);
  await s.page.click(selector, { timeout: clickTimeout });
  await s.page.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT_MS }).catch(() => {});
  return { url: s.page.url(), title: await s.page.title().catch(() => ''), lastError: s.lastError };
}

export async function browseWaitForSelector({ sessionId, selector, state = 'visible', timeout = WAIT_FOR_SELECTOR_TIMEOUT_MS }) {
  const s = requireSession(sessionId);
  if (!selector) { const e = new Error('wait_for_selector requires a selector'); e.status = 400; throw e; }
  const validStates = ['attached', 'detached', 'visible', 'hidden'];
  if (!validStates.includes(state)) {
    const e = new Error(`invalid state: ${state}. must be one of ${validStates.join(', ')}`);
    e.status = 400;
    throw e;
  }
  try {
    await s.page.waitForSelector(selector, { state, timeout });
    return { ok: true, state, lastError: s.lastError };
  } catch (e) {
    const err = new Error(`wait_for_selector timeout: ${e.message}`);
    err.status = 408;
    err.lastError = e.message;
    throw err;
  }
}

export async function browseType({ sessionId, selector, text }) {
  const s = requireSession(sessionId);
  if (!selector || text == null) { const e = new Error('type requires selector and text'); e.status = 400; throw e; }
  const clickTimeout = parseInt(process.env.ORGANIC_CLICK_TIMEOUT_MS || '30000', 10);
  await s.page.click(selector, { timeout: clickTimeout }).catch(() => {}); // focus
  await s.page.fill(selector, String(text));
  return { ok: true, lastError: s.lastError };
}

export async function browseEvaluate({ sessionId, expression }) {
  const s = requireSession(sessionId);
  if (!expression) { const e = new Error('evaluate requires an expression'); e.status = 400; throw e; }
  const result = await s.page.evaluate(expression);
  return { result: result === undefined ? null : result, lastError: s.lastError };
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

export { evictIdle as browseEvictIdle, activeCount as browseActiveCount };
