/**
 * Organic Activity Engine — CamoFox adapter (A/B "engine B").
 *
 * CamoFox is a self-hosted, deep-patched Firefox-based browser with an HTTP
 * tab API (POST /tabs, /tabs/:id/evaluate, /tabs/:id/navigate, cookie import,
 * session teardown). Unlike our Chromium path it exposes NO Playwright locator
 * API and NO network-response interception — the universal primitive is
 * `POST /tabs/:tabId/evaluate {expression}` (an async JS IIFE run in-page).
 *
 * What this buys us for the A/B test: a GENUINELY DIFFERENT browser engine —
 * real Firefox TLS/JA3 fingerprint, WebRTC blocked in-browser, real fonts —
 * so the platforms see a different network+device signature than our Chromium
 * identity. That is the whole value of the second layer.
 *
 * What it does NOT support through the HTTP API (and we are honest about it):
 *   - network-verified reactions (needs `page.waitForResponse`, Chromium-only)
 *   - password login / 2FA forwarder (larger separate effort; cookie import only)
 * So a CamoFox warmup runs in VERIFIED-SCROLL mode: it scrolls the feed like a
 * reader (scroll position is read back to prove it actually scrolled) and
 * records `reactions: 0`. That still generates real organic browsing signal —
 * just without the reaction layer.
 */

import fs from 'fs';
import { cookieFileFor } from './accounts.js';
import { resolveCredentials } from '../credentials.js';
import { humanPause, randInt } from './behavior.js';
import { ORGANIC_CONFIG } from './config.js';

/** Derive a stable CamoFox userId from an account key (exported for tests). */
export function camofoxUserIdFor(account) {
  return `w1408-${(account.accountKey || accountKeyFrom(account)).replace(/:/g, '-')}`;
}
function accountKeyFrom(account) {
  return `${account.platform}:${account.persona || 'corporate'}`;
}

/**
 * A session over the CamoFox HTTP API that implements the same surface the
 * Chromium OrganicSession exposes to the warmup runner:
 *   .url(), .looksLoggedOut(), .saveState(), .close()
 * plus .open() (setup + cookie import) and .scrollVerified() (the engine's
 * scroll primitive, reading scroll position back to prove it worked).
 */
export class CamofoxSession {
  constructor({ account, baseUrl, apiKey }) {
    this.account = account;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.userId = camofoxUserIdFor(account);
    this.sessionKey = `organic-${Date.now()}`;
    this.tabId = null;
    this.creds = resolveCredentials(account.platform, account.persona || 'corporate');
    this.hasAuth = false;
  }

  async _request(method, path, body) {
    const url = this.baseUrl + path;
    const headers = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    if (!res.ok) {
      const msg = (json && (json.error || json.raw)) || res.statusText;
      throw new Error(`CamoFox ${method} ${path} -> ${res.status}: ${msg}`);
    }
    return json;
  }

  async _evaluate(expression) {
    const json = await this._request('POST', `/tabs/${this.tabId}/evaluate`, {
      userId: this.userId,
      expression,
    });
    return json.result;
  }

  /**
   * Evaluate a JS expression that RETURNS A VALUE. CamoFox's evaluate passes
   * the result back as-is, but multi-property objects don't always survive the
   * serialization — so we wrap the expression in JSON.stringify() on the page
   * and parse it back here. Pass the raw in-page expression (an IIFE that
   * returns a value); we wrap it.
   */
  async _evalJson(expression) {
    const raw = await this._evaluate(`(function(){ try { return JSON.stringify(${expression}); } catch (e) { return JSON.stringify({ __error: String(e) }); } })()`);
    if (typeof raw !== 'string') return raw;
    try { return JSON.parse(raw); } catch { return { __raw: raw }; }
  }

  /** Set up a session + tab, import the persona's cookies, navigate to feed. */
  async open(feedUrl) {
    // 1) create session + tab (navigates to feedUrl; may land on login wall).
    const created = await this._request('POST', '/tabs', {
      userId: this.userId,
      sessionKey: this.sessionKey,
      url: feedUrl,
    });
    this.tabId = created.tabId;

    // 2) import the persona's cookies so the feed is authenticated.
    if (await this._importCookies()) {
      // 3) reload now that cookies are in.
      await this._navigate(feedUrl).catch(() => {});
    }
    // 4) give the feed time to hydrate (Firefox/LinkedIn JS is slower than the
    //    skeleton; poll for a real feed marker up to ~20s before proceeding).
    await this._waitForFeed(feedUrl);
  }

  /**
   * Poll until the page looks like a real (authed) feed, or time out.
   * Robustness: LinkedIn/LinkedIn-in-Firefox hydrates at variable speed, so a
   * single scrollH sample can look "too short" mid-load. We therefore also
   * accept a feed whose scrollHeight is GROWING across polls (posts actively
   * streaming in) — not just a one-shot hard threshold. A truly empty/authwall
   * page shows neither a marker nor growth, so it still times out honestly.
   */
  async _waitForFeed(feedUrl, { timeoutMs = 25000 } = {}) {
    const start = Date.now();
    let prevH = 0;
    let grew = 0;
    while (Date.now() - start < timeoutMs) {
      const st = await this._evalJson(
        `({ url: location.href, scrollH: document.documentElement.scrollHeight,
            marker: !!document.querySelector(".feed-shared-update-v2, .share-box-feed-entry, main[role=main] .scaffold-layout__content") })`
      ).catch(() => null);
      const url = (st && st.url) || '';
      const h = (st && st.scrollH) || 0;
      if (this._isLoggedOutUrl(url)) {
        console.log(`[Camofox] Landed on login/authwall (${url}) — session not authenticated.`);
        return false;
      }
      // Explicit feed marker, OR a tall enough page, OR a page actively growing.
      if (st && st.marker) {
        console.log(`[Camofox] Feed hydrated (marker, url=${url} scrollH=${h}).`);
        return true;
      }
      if (h - prevH > 150) { grew += (h - prevH); } else { grew = 0; }
      prevH = h;
      if (h > 1400 || grew > 900) {
        console.log(`[Camofox] Feed hydrated (scrollH=${h}, grew=${grew}).`);
        return true;
      }
      await humanPause(1500, 2500);
    }
    console.warn(`[Camofox] Feed did not fully hydrate within timeout (final scrollH=${prevH}); proceeding cautiously.`);
    return prevH > 1400;
  }

  _isLoggedOutUrl(url) {
    return !url || url.startsWith('about:') || url.startsWith('chrome-error') ||
      url.includes('login') || url.includes('checkpoint') || url.includes('authwall') || url.includes('/i/flow/login');
  }

  async _importCookies() {
    const cookieFile = cookieFileFor(this.account);
    const cookies = [];
    // (a) cookie jar file, if present.
    if (fs.existsSync(cookieFile)) {
      try {
        const raw = JSON.parse(fs.readFileSync(cookieFile, 'utf8'));
        for (const c of raw) {
          const { sameSite, ...rest } = c;
          cookies.push({ ...rest, sameSite: sameSite === 'Strict' || sameSite === 'Lax' ? sameSite : 'None' });
        }
      } catch {}
    }
    // (b) token cookies (li_at / auth_token) from creds, mirroring session.js.
    if (this.creds.liAt) {
      for (const domain of ['.www.linkedin.com', '.linkedin.com']) {
        cookies.push({ name: 'li_at', value: this.creds.liAt, domain, path: '/', httpOnly: true, secure: true, sameSite: 'None' });
      }
    }
    if (this.creds.authToken) {
      cookies.push({ name: 'auth_token', value: this.creds.authToken, domain: '.x.com', path: '/', httpOnly: true, secure: true, sameSite: 'None' });
      if (this.creds.ct0) cookies.push({ name: 'ct0', value: this.creds.ct0, domain: '.x.com', path: '/', secure: true, sameSite: 'Lax' });
    }
    if (!cookies.length) return false;
    // CamoFox caps at 500 cookies/request; ours are far fewer.
    await this._request('POST', `/sessions/${this.userId}/cookies`, { cookies: cookies.slice(0, 500) });
    this.hasAuth = true;
    return true;
  }

  async _navigate(url) {
    await this._request('POST', `/tabs/${this.tabId}/navigate`, { userId: this.userId, url });
  }

  url() {
    // Cheap: evaluate location.href.
    return this._evalJson('location.href').catch(() => '');
  }

  looksLoggedOut() {
    return this._evalJson(
      `(function(){ const u = location.href; return u.startsWith('about:') || u.includes('login') || u.includes('checkpoint') || u.includes('authwall') || u.includes('/i/flow/login'); })()`
    ).catch(() => true);
  }

  /**
   * Scroll the feed in N human-ish steps. CRITICAL CamoFox API constraint:
   * `/tabs/:id/evaluate` does NOT await async functions (it serializes the
   * returned Promise as {}), so all in-page JS must be SYNCHRONOUS. We therefore
   * drive the scroll from the client: fire a synchronous scroll step, wait on
   * the Node side, read scrollY back with a synchronous evaluate, and repeat.
   * This still VERIFIES real scroll (reads scrollY before/after each step).
   */
  async scrollVerified() {
    const steps = randInt(ORGANIC_CONFIG.camofoxScrollSteps - 1, ORGANIC_CONFIG.camofoxScrollSteps + 2);
    let advanced = 0;
    let lastY = await this._evalJson('window.scrollY').catch(() => 0) || 0;
    for (let i = 0; i < steps; i++) {
      const before = lastY;
      // synchronous in-page scroll step (no async, so evaluate returns the value)
      const delta = 500 + Math.floor(Math.random() * 600);
      await this._evaluate(`window.scrollBy(0, ${delta}); true`).catch(() => {});
      // human reading dwell (Node-side, keeps total dwell human-like)
      await new Promise(r => setTimeout(r, 900 + Math.floor(Math.random() * 900)));
      lastY = await this._evalJson('window.scrollY').catch(() => before) || before;
      if (lastY - before > 40) advanced++;
      await new Promise(r => setTimeout(r, 500 + Math.floor(Math.random() * 1500)));
    }
    const url = await this.url().catch(() => '');
    // Assert we are still on the real feed (not bounced to authwall mid-scroll).
    if (url && (url.includes('authwall') || url.includes('login') || url.startsWith('chrome-error'))) {
      throw new Error(`CamoFox scroll landed off-feed (${url}) — refusing to count.`);
    }
    return { scrolls: advanced, requested: steps, scrollY: lastY };
  }

  // CamoFox persists cookies in its own profile volume — nothing to write back.
  async saveState() { /* no-op: profile-persistent */ }

  async close() {
    try { if (this.tabId) await this._request('DELETE', `/tabs/${this.tabId}`, { userId: this.userId }); } catch {}
    try { await this._request('DELETE', `/sessions/${this.userId}`, { userId: this.userId }); } catch {}
    this.tabId = null;
  }
}

/**
 * Open a CamoFox session for an account. Mirrors the return shape warmup.js
 * expects (an object with url/looksLoggedOut/saveState/close + a scroll hook).
 */
export async function openCamofoxSession(account, { feedUrl } = {}) {
  const session = new CamofoxSession({
    account,
    baseUrl: ORGANIC_CONFIG.camofoxBaseUrl,
    apiKey: ORGANIC_CONFIG.camofoxApiKey,
  });
  await session.open(feedUrl);
  // Brief settle for the feed to render post-cookie-import.
  await humanPause(1200, 2500);
  return session;
}
