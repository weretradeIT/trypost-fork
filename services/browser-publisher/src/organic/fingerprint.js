/**
 * Organic Activity Engine — fingerprint alignment.
 *
 * The headless Chromium in the container leaks dozens of signals that no real
 * local browser produces. This module patches the Playwright context so the
 * sessions present a coherent, human-aligned identity:
 *
 *   - navigator.platform → matches the UA (MacIntel for macOS UA)
 *   - navigator.languages → ['de-DE','de','en-US','en'] (not just ['de-DE'])
 *   - navigator.plugins → non-empty (PDF viewer + Chrome PDF)
 *   - navigator.deviceMemory → ≤ 8 (Chrome caps at 8; headless shows 32)
 *   - window.chrome → present with runtime/app stubs
 *   - timezone → Europe/Berlin (container is UTC)
 *   - WebGL vendor/renderer → ANGLE/Metal, not SwiftShader
 *   - outer > inner dims, window positioned on screen
 *
 * These run as addInitScript so they apply BEFORE any platform JS loads.
 */

import { ORGANIC_CONFIG } from './config.js';

// UA → platform mapping for the two fingerprints we use.
const PLATFORM_FOR_UA = {
  mac: 'MacIntel',
  win: 'Win32',
};

function platformFromUA(ua) {
  if (/Macintosh|Mac OS X/.test(ua)) return PLATFORM_FOR_UA.mac;
  if (/Windows/.test(ua)) return PLATFORM_FOR_UA.win;
  return 'Linux x86_64';
}

/**
 * Build the init script for a given UA.  Runs before every page's JS.
 *
 * `platform` is the logical key ('linkedin' = macOS Chrome, 'x' = Windows
 * Chrome) so userAgentData / connection can align with BOTH the UA and the
 * Sec-Ch-Ua header (both derived from the same platform in browser.js).
 */
export function fingerprintInitScript(userAgent, platform = 'linkedin') {
  const navPlatform = platformFromUA(userAgent);
  const languages = JSON.stringify(['de-DE', 'de', 'en-US', 'en']);
  const tz = JSON.stringify(ORGANIC_CONFIG.timezone || 'Europe/Berlin');
  // Client-hints platform string must MATCH the Sec-Ch-Ua-Platform header in
  // browser.js exactly: linkedin → "macOS", x → "Windows".
  const isMac = String(platform || '').toLowerCase() === 'linkedin' || /Macintosh|Mac OS X/.test(userAgent);
  const chPlatform = isMac ? 'macOS' : 'Windows';
  const chromeMajor = (ORGANIC_CONFIG.chromeMajor || '151');
  // architecture/bitness/model aligned per platform:
  //   macOS Intel  → x86 / 64 / model ''
  //   Windows      → x86 / 64 / model ''
  const archInfo = { architecture: 'x86', bitness: '64', model: '' };
  // platformVersion (OS build) — precomputed in Node so the IIFE never needs
  // the Node-only `isMac`. macOS 14.5 / Windows 15.0 are plausible current OS
  // builds that agree with the Mac OS X 10_15_7 / Windows NT 10.0 UA strings.
  const platformVersion = isMac ? '14.5.0' : '15.0.0';

  return `
(function() {
  const navPlatform = ${JSON.stringify(navPlatform)};
  const langs = ${languages};
  const tz = ${tz};
  const chPlatform = ${JSON.stringify(chPlatform)};
  const chromeMajor = ${JSON.stringify(chromeMajor)};
  const archInfo = ${JSON.stringify(archInfo)};
  const platformVersion = ${JSON.stringify(platformVersion)};

  // --- navigator.platform ---
  try {
    Object.defineProperty(navigator, 'platform', { get: () => navPlatform, configurable: true });
  } catch {}

  // --- navigator.languages (array, not just the locale) ---
  try {
    Object.defineProperty(navigator, 'languages', { get: () => langs, configurable: true });
  } catch {}

  // --- navigator.deviceMemory: Chrome caps at 8 ---
  try {
    if (navigator.deviceMemory > 8) {
      Object.defineProperty(navigator, 'deviceMemory', { get: () => 8, configurable: true });
    }
  } catch {}

  // --- navigator.plugins + mimeTypes: headless ships 0/0; real macOS Chrome
  // ships 5 PDF plugins + 3 PDF mime types, cross-referenced. The two lists
  // must agree or fingerprinters flag the mismatch immediately. ---
  try {
    if (navigator.plugins.length === 0) {
      const MIMES = [
        ['application/pdf', 'Portable Document Format', 'pdf'],
        ['text/pdf', 'Portable Document Format', 'pdf'],
        ['text/x-pdf', 'Portable Document Format', 'pdf'],
      ];
      const mimeArr = Object.create(MimeTypeArray.prototype);
      MIMES.forEach(([type, desc, suffix], i) => {
        const m = Object.create(MimeType.prototype);
        Object.defineProperties(m, {
          type: { value: type },
          suffixes: { value: suffix },
          description: { value: desc },
        });
        Object.defineProperty(mimeArr, i, { value: m, enumerable: true });
        Object.defineProperty(mimeArr, type, { value: m });
      });
      Object.defineProperty(mimeArr, 'length', { value: MIMES.length });
      mimeArr.item = (i) => mimeArr[i] || null;
      mimeArr.namedItem = (t) => mimeArr[t] || null;

      const NAMES = [
        'PDF Viewer',
        'Chrome PDF Viewer',
        'Chromium PDF Viewer',
        'Microsoft Edge PDF Viewer',
        'WebKit built-in PDF',
      ];
      const plugArr = Object.create(PluginArray.prototype);
      NAMES.forEach((name, i) => {
        const p = Object.create(Plugin.prototype);
        Object.defineProperties(p, {
          name: { value: name },
          filename: { value: 'internal-pdf-viewer' },
          description: { value: 'Portable Document Format' },
          length: { value: MIMES.length },
        });
        p.item = (j) => mimeArr[j] || null;
        p.namedItem = (t) => mimeArr[t] || null;
        p.refresh = () => {};
        Object.defineProperty(plugArr, i, { value: p, enumerable: true });
        Object.defineProperty(plugArr, name, { value: p });
      });
      Object.defineProperty(plugArr, 'length', { value: NAMES.length });
      plugArr.item = (i) => plugArr[i] || null;
      plugArr.namedItem = (n) => plugArr[n] || null;
      plugArr.refresh = () => {};

      Object.defineProperty(navigator, 'plugins', { get: () => plugArr, configurable: true });
      Object.defineProperty(navigator, 'mimeTypes', { get: () => mimeArr, configurable: true });
    }
  } catch {}

  // --- window.chrome: headless omits it entirely ---
  try {
    if (typeof window.chrome === 'undefined') {
      window.chrome = {
        runtime: { id: undefined, onConnect: undefined, onMessage: undefined, connect: () => {}, sendMessage: () => {} },
        app: { isInstalled: false },
        csi: () => ({ onloadT: Date.now(), startE: Date.now(), pageT: Math.random() * 5000 }),
        loadTimes: () => ({ requestTime: Date.now() / 1000, startLoadReason: 'explicit', finishLoadReason: 'navigation' }),
      };
    }
  } catch {}

  // --- Permissions API: Notification permission should be 'default' not 'denied' ---
  try {
    if (Notification.permission === 'denied') {
      Object.defineProperty(Notification, 'permission', { get: () => 'default', configurable: true });
    }
  } catch {}

  // --- WebGL vendor/renderer: headless shows 'WebKit'/'WebKit WebGL' (SwiftShader).
  // Both WebGL1 and WebGL2 contexts must report the same aligned values —
  // fingerprinters check both. ---
  try {
    const patchGL = (proto) => {
      if (!proto) return;
      const origGetParameter = proto.getParameter;
      proto.getParameter = function (param) {
        // UNMASKED_VENDOR_WEBGL = 0x9245, UNMASKED_RENDERER_WEBGL = 0x9246
        if (param === 0x9245) return 'Google Inc. (Apple)';
        if (param === 0x9246) return 'ANGLE (Apple, Apple M2 Pro, OpenGL 4.1)';
        // VENDOR / RENDERER
        if (param === 0x1f00) return 'WebKit';
        if (param === 0x1f01) return 'WebKit WebGL';
        return origGetParameter.call(this, param);
      };
    };
    patchGL(window.WebGLRenderingContext && WebGLRenderingContext.prototype);
    patchGL(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);
  } catch {}

  // --- AudioContext: a headless container has NO audio device, so the standard
  // 10kHz-oscillator AudioContext fingerprint reads as an ALL-ZERO flat line —
  // a hard bot tell (real macOS Chrome always has audio HW and returns a
  // characteristic non-zero waveform). We make getFloatTimeDomainData return a
  // deterministic, plausible non-zero signal. It is STABLE across loads (a
  // device's audio fingerprint doesn't change), which is what a detector
  // checks: zeros = no device (bot); stable non-zero = real hardware. ---
  try {
    const patchAnalyser = (proto) => {
      if (!proto || !proto.getFloatTimeDomainData) return;
      const origGetFloat = proto.getFloatTimeDomainData.bind ? proto.getFloatTimeDomainData.bind(proto) : null;
      // Deterministic non-zero waveform, seeded so it is stable per browser
      // identity (not per load). 256 bins is the common fingerprint fftSize.
      const stableSeed = 0x9e3779b9; // golden-ratio constant; fixed, not Date.now()
      proto.getFloatTimeDomainData = function (array) {
        const n = array.length || 256;
        for (let i = 0; i < n; i++) {
          // A real 10kHz triangle-through-compressor produces a smooth
          // non-zero signal with slight noise. Reproduce a plausible shape:
          // a decaying cosine plus low-amplitude deterministic noise.
          const base = Math.cos((i / n) * Math.PI * 2) * 0.28;
          const noise = (Math.sin((i * 13.37 + stableSeed) ) * 0.021);
          array[i] = (base + noise);
        }
        return array;
      };
    };
    patchAnalyser(window.AnalyserNode && AnalyserNode.prototype);
  } catch {}

  // --- browser frame geometry: headless reports outer == inner (no title bar
  // / tab strip / bookmarks bar) and often screenX/Y at 0. A real browser
  // window is always TALLER (and, on macOS, slightly WIDER) than the
  // viewport, and sits somewhere on the desktop. Apply unconditionally — the
  // earlier equality pre-check was already false by init time in this build,
  // which silently skipped the patch. ---
  try {
    const isMac = /Macintosh|Mac OS X/.test(navigator.userAgent);
    const extraW = isMac ? 2 : 16;
    const extraH = isMac ? 88 : 122; // tab strip + address bar + bookmarks
    const _oW = window.innerWidth + extraW;
    const _oH = window.innerHeight + extraH;
    const _sx = isMac ? 0 : Math.floor(Math.random() * 160);
    const _sy = isMac ? 37 : Math.floor(Math.random() * 90); // macOS menu bar offset
    try {
      Object.defineProperty(window, 'outerWidth', { get: () => _oW, configurable: true });
      Object.defineProperty(window, 'outerHeight', { get: () => _oH, configurable: true });
      Object.defineProperty(window, 'screenX', { get: () => _sx, configurable: true });
      Object.defineProperty(window, 'screenY', { get: () => _sy, configurable: true });
    } catch (e) {
      // A few builds make these non-configurable; the values above were
      // at least recorded for the window resize event path.
    }
    // Keep screen dimensions consistent with the viewport + frame.
    try {
      Object.defineProperty(screen, 'width', { get: () => Math.max(window.screen.width, _oW), configurable: true });
      Object.defineProperty(screen, 'height', { get: () => Math.max(window.screen.height, _oH), configurable: true });
    } catch {}
  } catch {}

  // --- navigator.userAgentData (Client Hints JS API) — THE critical new wave.
  // A real Chrome 151 ALWAYS exposes navigator.userAgentData. Headless
  // Chromium in this build exposes NONE (probe: userAgentData_present=false)
  // while the UA + Sec-Ch-Ua header scream "Chrome 151" — a direct, instant
  // contradiction. We synthesize a coherent object whose brands /
  // fullVersionList / platform MATCH the Sec-Ch-Ua header and UA exactly, so
  // the in-page API and the on-wire header cross-check clean. ---
  try {
    if (typeof navigator.userAgentData === 'undefined') {
      const brands = [
        { brand: 'Chromium', version: chromeMajor },
        { brand: 'Not_A Brand', version: '24' },
        { brand: 'Google Chrome', version: chromeMajor },
      ];
      const fullVersionList = [
        { brand: 'Chromium', version: chromeMajor + '.0.0.0' },
        { brand: 'Not_A Brand', version: '24.0.0.0' },
        { brand: 'Google Chrome', version: chromeMajor + '.0.0.0' },
      ];
      const highEntropyBase = {
        architecture: archInfo.architecture,
        bitness: archInfo.bitness,
        model: archInfo.model,
        platform: chPlatform,
        platformVersion: platformVersion,
        uaFullVersion: chromeMajor + '.0.0.0',
        fullVersionList: fullVersionList,
      };
      const uad = {
        brands: brands,
        fullVersionList: fullVersionList,
        mobile: false,
        platform: chPlatform,
        getHighEntropyValues: (hints) => {
          const out = {};
          const allowed = ['architecture','bitness','model','platform','platformVersion','uaFullVersion','fullVersionList','formFactor','wow64'];
          (hints || allowed).forEach((h) => { if (allowed.includes(h) && h in highEntropyBase) out[h] = highEntropyBase[h]; });
          if (hints && hints.includes('formFactor')) out.formFactor = 'desktop';
          if (hints && hints.includes('wow64')) out.wow64 = false;
          return Promise.resolve(out);
        },
        getArch: () => Promise.resolve(archInfo.architecture),
        test: (label) => Promise.resolve(false),
        toJSON: () => ({ brands: brands, fullVersionList: fullVersionList, mobile: false, platform: chPlatform }),
      };
      Object.defineProperty(navigator, 'userAgentData', { get: () => uad, configurable: true });
    }
  } catch {}

  // --- navigator.connection (Network Information API) — real Chrome ALWAYS
  // has it with a NON-ZERO rtt and a "type" (wifi/ethernet). Headless here
  // reports rtt:0 and no type → a tell. Make it stable + plausible. ---
  try {
    const conn = navigator.connection;
    if (conn) {
      const stable = { effectiveType: '4g', type: 'wifi', downlink: 9.6, rtt: 50, saveData: false };
      try { Object.defineProperty(conn, 'rtt', { get: () => stable.rtt, configurable: true }); } catch {}
      try { Object.defineProperty(conn, 'type', { get: () => stable.type, configurable: true }); } catch {}
      try { Object.defineProperty(conn, 'downlink', { get: () => stable.downlink, configurable: true }); } catch {}
      try { Object.defineProperty(conn, 'effectiveType', { get: () => stable.effectiveType, configurable: true }); } catch {}
      try { Object.defineProperty(conn, 'saveData', { get: () => stable.saveData, configurable: true }); } catch {}
    } else {
      // Some headless builds omit connection entirely; real Chrome has it.
      const fake = {
        effectiveType: '4g', type: 'wifi', downlink: 9.6, rtt: 50, saveData: false,
        addEventListener: () => {}, removeEventListener: () => {}, onchange: null,
      };
      Object.defineProperty(navigator, 'connection', { get: () => fake, configurable: true });
    }
  } catch {}

  // --- window.caches — real Chrome exposes the Cache Storage API. Headless
  // here reports it absent. Provide a minimal present stub. ---
  try {
    if (typeof window.caches === 'undefined' && typeof CacheStorage !== 'undefined') {
      Object.defineProperty(window, 'caches', { value: new CacheStorage(), configurable: true });
    }
  } catch {}
})();
`;
}
