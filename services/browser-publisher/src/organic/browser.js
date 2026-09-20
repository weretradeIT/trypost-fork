/**
 * Organic Activity Engine — shared browser identity factory.
 *
 * THE single place that decides what every browser session (warmup AND
 * publish) presents to the platform: launch args, proxy, per-platform UA,
 * viewport, locale, timezone, Accept-Language, client hints, and the
 * fingerprint init script. Both the warmup sessions (session.js) and the
 * publishers (publishers/linkedin-publisher.js, publishers/x-publisher.js)
 * MUST go through here so that organic and publish traffic share one
 * coherent identity per platform.
 *
 * Identity rules (must stay consistent, or the platform sees one account
 * coming from two different "browsers"):
 *   - LinkedIn sessions  → macOS Chrome   (MacIntel, 1440×900)
 *   - X sessions         → Windows Chrome (Win32,   1920×1080)
 *   - UA version matches the real Chromium build in the container (151),
 *     so Sec-Ch-Ua and the UA header do not disagree.
 *
 * Client hints (the single biggest headless tell): headless Chromium stamps
 * "HeadlessChrome" into sec-ch-ua, and that brand survives every Playwright
 * context option. Two things were tested live inside the container:
 *   - CDP Network.setUserAgentOverride with a secChUa value SUPPRESSES the
 *     whole client-hint group (the header disappears) — a stronger signal.
 *   - context extraHTTPHeaders cleanly REPLACES sec-ch-ua with the correct
 *     "Google Chrome" brand, on every page and every request, with no race
 *     (set before any page exists). That is the mechanism used here.
 * The native hint set for this Chromium build is exactly sec-ch-ua,
 * sec-ch-ua-mobile and sec-ch-ua-platform (no sec-ch-ua-full-version-list),
 * so we send exactly those three to match real Chrome — not one more.
 */

import { chromium } from 'playwright';
import { ORGANIC_CONFIG } from './config.js';
import { assertEgressAllowed } from './egress.js';
import { fingerprintInitScript } from './fingerprint.js';

const CHROME_MAJOR = process.env.ORGANIC_CHROME_MAJOR || '151';

export const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-blink-features=AutomationControlled',
  // WebRTC must route through the proxy. Otherwise ICE leaks the host (datacenter)
  // IP via STUN even though the page loads through the residential proxy — a hard
  // cross-signal contradiction. With no non-proxied path, ICE candidates come from
  // the proxy egress, so the leaked IP == the egress IP.
  '--webrtc-ip-handling-policy=disable_non_proxied',
  // Belt-and-suspenders: also force ICE to proxy-only so no local/host candidate
  // is even generated.
  '--force-webrtc-ip-handling-policy=disable_non_proxied',
];

const UA_BY_PLATFORM = {
  linkedin: () =>
    `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`,
  x: () =>
    `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`,
};

const VIEWPORT_BY_PLATFORM = {
  linkedin: { width: 1440, height: 900 },
  x: { width: 1920, height: 1080 },
};

/** Resolve the UA for a platform (unknown → treat as X/Windows default). */
export function userAgentFor(platform) {
  const key = String(platform || '').toLowerCase();
  return (UA_BY_PLATFORM[key] || UA_BY_PLATFORM.x)();
}

/** Resolve the viewport for a platform. */
export function viewportFor(platform) {
  const key = String(platform || '').toLowerCase();
  return VIEWPORT_BY_PLATFORM[key] || VIEWPORT_BY_PLATFORM.x;
}

/**
 * The client-hint headers that must replace headless Chromium's.
 *
 * sec-ch-ua carries the SAME major as the UA (151) so the two never disagree.
 * Real Chrome brands are Chromium / Not_A Brand / Google Chrome — the
 * "HeadlessChrome" brand that leaks from the raw build is gone.
 */
export function clientHintsFor(platform, chromeMajor = CHROME_MAJOR) {
  const key = String(platform || '').toLowerCase();
  const isMac = key === 'linkedin';
  return {
    'sec-ch-ua': `"Chromium";v="${chromeMajor}", "Not_A Brand";v="24", "Google Chrome";v="${chromeMajor}"`,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': isMac ? '"macOS"' : '"Windows"',
  };
}

/** German-Chrome accept-language, matching a real DE locale. */
const ACCEPT_LANGUAGE = 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7';

/**
 * Create an aligned browser + context for `platform`.
 *
 * Runs the HARD egress guardrail first (fail-closed), applies the residential
 * proxy if configured, sets the per-platform identity (UA + aligned client
 * hints via extraHTTPHeaders), and injects the fingerprint alignment script
 * BEFORE any page JS loads.
 *
 * Returns { browser, context, close } — the caller owns cookie injection,
 * navigation and closing via close().
 */
export async function createAlignedBrowser({ platform = 'x', headless = true } = {}) {
  // HARD: no platform traffic from a datacenter IP. Covers warmup + publish.
  await assertEgressAllowed();

  const launchOpts = { headless, args: [...LAUNCH_ARGS] };
  if (ORGANIC_CONFIG.browserProxy) {
    launchOpts.proxy = { server: ORGANIC_CONFIG.browserProxy };
  }

  const browser = await chromium.launch(launchOpts);
  const ua = userAgentFor(platform);
  const key = String(platform || '').toLowerCase();

  const context = await browser.newContext({
    viewport: viewportFor(platform),
    userAgent: ua,
    locale: 'de-DE',
    timezoneId: ORGANIC_CONFIG.timezone || 'Europe/Berlin',
    // extraHTTPHeaders are applied to EVERY request from this context, set
    // before any page exists — so the very first document request already
    // carries the aligned sec-ch-ua (no first-request leak, no CDP race).
    extraHTTPHeaders: {
      'Accept-Language': ACCEPT_LANGUAGE,
      ...clientHintsFor(platform),
    },
  });

  // Align the in-page fingerprint (navigator, plugins, WebGL, frame geometry,
  // userAgentData, connection) BEFORE any platform JS loads.
  await context.addInitScript(fingerprintInitScript(ua, platform));

  // Accept-Language: Blink derives the header from the `locale` context option
  // and OVERWRITES our extraHTTPHeaders value (so the full German fallback chain
  // gets truncated to "de-DE"). We keep `locale: 'de-DE'` because it's what makes
  // navigator.language/navigator.languages report German in-page. To also send the
  // full Accept-Language chain on the wire, re-assert it at the route layer — a
  // route-level header override runs AFTER Blink and wins the race.
  await context.route('**/*', (route) => {
    const headers = { ...route.request().headers() };
    headers['accept-language'] = ACCEPT_LANGUAGE;
    route.continue({ headers });
  });

  const close = async () => {
    await browser.close().catch(() => {});
  };

  return { browser, context, platform: key, userAgent: ua, close };
}
