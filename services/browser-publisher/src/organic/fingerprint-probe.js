/**
 * Fingerprint/egress audit probe — runs INSIDE the browser context.
 *
 * Dumps: outbound request headers (incl. sec-ch-ua client hints), navigator
 * properties, screen/canvas/audio signals, and the egress IP + its ASN/type.
 * Usage: docker exec trypost-browser-publisher node /app/src/organic/fingerprint-probe.js
 */

import { chromium } from 'playwright';

const ECHO_URL = 'https://httpbin.org/headers'; // echoes back request headers
const IP_URL = 'https://ipinfo.io/json'; // IP + ASN/company/type

const browser = await chromium.launch({
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
  ],
});

const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  locale: 'de-DE',
  extraHTTPHeaders: { 'Accept-Language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7' },
});

const page = await context.newPage();

// ---- 1. Outbound headers as seen by a server ------------------------------
let echoHeaders = null;
try {
  const res = await page.goto(ECHO_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
  echoHeaders = (await res.json())?.headers;
} catch (e) {
  console.log('echo failed:', e.message.split('\n')[0]);
}

// ---- 2. In-page fingerprint signals ----------------------------------------
const signals = await page.evaluate(() => {
  const nav = navigator;
  const results = {};
  try {
    results.webdriver = nav.webdriver;
    results.userAgent = nav.userAgent;
    results.appVersion = nav.appVersion;
    results.platform = nav.platform;
    results.languages = nav.languages;
    results.hardwareConcurrency = nav.hardwareConcurrency;
    results.deviceMemory = nav.deviceMemory;
    results.maxTouchPoints = nav.maxTouchPoints;
    results.pluginsLength = nav.plugins?.length ?? null;
    results.pluginNames = Array.from(nav.plugins || []).map((p) => p.name);
    results.mimeTypesLength = nav.mimeTypes?.length ?? null;
    results.windowChrome = typeof window.chrome !== 'undefined';
    results.chromeRuntime = typeof window.chrome?.runtime !== 'undefined';
    results.chromeApp = typeof window.chrome?.app !== 'undefined';
    results.permissionsNotification = typeof Notification !== 'undefined' ? Notification.permission : 'n/a';
    results.notificationAPI = 'Notification' in window;
    results.screen = { w: screen.width, h: screen.height, availW: screen.availWidth, availH: screen.availHeight, colorDepth: screen.colorDepth, pixelDepth: screen.pixelDepth };
    results.devicePixelRatio = window.devicePixelRatio;
    results.outerDims = { w: window.outerWidth, h: window.outerHeight };
    results.innerDims = { w: window.innerWidth, h: window.innerHeight };
    results.screenX = window.screenX;
    results.screenY = window.screenY;
    results.hasNotification = 'Notification' in window;
    // CDP/automation artifacts
    results.cdcVariables = Object.keys(window).filter((k) => k.startsWith('cdc_')).length > 0;
    results.domAutomation = typeof window.domAutomation !== 'undefined' || typeof window.domAutomationController !== 'undefined';
    results.playwright = '__playwright__' in window || '__pwInitScripts' in window;
    results.webdriverInName = Object.keys(window).some((k) => /webdriver|selenium|driver/i.test(k));
    // WebGL
    try {
      const gl = document.createElement('canvas').getContext('webgl');
      results.webglVendor = gl?.getParameter(gl.VENDOR);
      results.webglRenderer = gl?.getParameter(gl.RENDERER);
    } catch { results.webglVendor = 'error'; }
    // Canvas 2d hash (weak but indicative)
    try {
      const c = document.createElement('canvas');
      c.width = 220; c.height = 30;
      const ctx = c.getContext('2d');
      ctx.textBaseline = 'top';
      ctx.font = "14px 'Arial'";
      ctx.fillStyle = '#f60';
      ctx.fillRect(125, 1, 62, 20);
      ctx.fillStyle = '#069';
      ctx.fillText(' fingerprints 🙃', 2, 15);
      results.canvasHash = c.toDataURL().length;
    } catch { results.canvasHash = 'error'; }
    // Audio context state
    try {
      results.audioContext = typeof AudioContext !== 'undefined' ? 'present' : 'missing';
    } catch { results.audioContext = 'error'; }
    // Fonts heuristic (count of local font access via measureText differences)
    results.fontsProbe = document.fonts?.check('12px Arial');
    // Timezone + locale
    results.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    results.timezoneOffset = new Date().getTimezoneOffset();
    // Do we speak "de" like the headers claim?
    results.intlLocale = Intl.DateTimeFormat().resolvedOptions().locale;
    // Permissions API
    results.permQueryNotif = typeof navigator.permissions?.query === 'function';
  } catch (e) {
    results.evalError = e.message;
  }
  return results;
});

// ---- 3. Egress IP + ASN/type (in-browser AND node-level) -------------------
let ipInfo = null;
try {
  const res = await page.evaluate(async () => {
    const r = await fetch('https://ipinfo.io/json');
    return r.json();
  });
  ipInfo = res;
} catch (e) {
  console.log('ipinfo failed:', e.message.split('\n')[0]);
}

console.log('=== OUTBOUND HEADERS (server view) ===');
console.log(JSON.stringify(echoHeaders, null, 2));
console.log('=== NAVIGATOR/PAGE SIGNALS ===');
console.log(JSON.stringify(signals, null, 2));
console.log('=== EGRESS (browser context) ===');
console.log(JSON.stringify(ipInfo, null, 2));

await browser.close();
