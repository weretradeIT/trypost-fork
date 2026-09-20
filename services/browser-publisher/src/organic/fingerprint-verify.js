/**
 * Fingerprint verification — proves the aligned identity actually takes effect.
 *
 * Runs INSIDE the container. Boots the shared identity factory
 * (createAlignedBrowser) and dumps what a platform would observe: outgoing
 * request headers (incl. Sec-Ch-Ua) plus all in-page JS signals.
 *
 * Usage:  node fingerprint-verify.js [linkedin|x]
 * NOTE:   run with ORGANIC_EGRESS_ENFORCE=false for the audit — the guardrail
 *         itself is verified separately, live, with enforcement on.
 */
import { createAlignedBrowser } from './browser.js';

const platform = process.argv[2] || 'linkedin';
const { context, close } = await createAlignedBrowser({ platform, headless: true });

try {
  const page = await context.newPage();
  let docHeaders = null;
  page.on('request', (r) => {
    if (!docHeaders && r.resourceType() === 'document') docHeaders = r.headers();
  });

  await page.goto('https://ipinfo.io/json', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1500);

  const signals = await page.evaluate(() => {
    let webgl = null;
    let webgl2 = null;
    const probe = (kind) => {
      const c = document.createElement('canvas');
      const gl = c.getContext(kind);
      if (!gl) return null;
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      return {
        vendor: gl.getParameter(0x1f00),
        unmaskedVendor: dbg ? gl.getParameter(0x9245) : null,
        renderer: gl.getParameter(0x1f01),
        unmaskedRenderer: dbg ? gl.getParameter(0x9246) : null,
      };
    };
    try {
      webgl = probe('webgl');
      webgl2 = probe('webgl2');
    } catch {}
    let mimeTypes = 0;
    let pluginMimeConsistency = null;
    try {
      mimeTypes = navigator.mimeTypes.length;
      // Cross-reference check a fingerprinter would do: each plugin must map
      // to the same mime types, and named lookups must round-trip.
      if (navigator.plugins.length) {
        const p0 = navigator.plugins[0];
        const viaPlugin = p0 && p0.length ? p0.item(0).type : null;
        const viaNamed = navigator.mimeTypes.namedItem('application/pdf').type;
        const viaArray = navigator.mimeTypes.item(0).type;
        pluginMimeConsistency = { viaPlugin, viaNamed, viaArray, consistent: viaPlugin === viaNamed && viaNamed === viaArray };
      }
    } catch {}
    return {
      ua: navigator.userAgent,
      platform: navigator.platform,
      languages: navigator.languages,
      plugins: navigator.plugins.length,
      mimeTypes,
      pluginMimeConsistency,
      deviceMemory: navigator.deviceMemory,
      hasWindowChrome: typeof window.chrome !== 'undefined',
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      inner: [window.innerWidth, window.innerHeight],
      outer: [window.outerWidth, window.outerHeight],
      screenXY: [window.screenX, window.screenY],
      hardwareConcurrency: navigator.hardwareConcurrency,
      maxTouchPoints: navigator.maxTouchPoints,
      webgl,
      webgl2,
    };
  });

  const interesting = {
    'user-agent': docHeaders?.['user-agent'],
    'sec-ch-ua': docHeaders?.['sec-ch-ua'],
    'sec-ch-ua-mobile': docHeaders?.['sec-ch-ua-mobile'],
    'sec-ch-ua-platform': docHeaders?.['sec-ch-ua-platform'],
    'accept-language': docHeaders?.['accept-language'],
  };

  console.log(JSON.stringify({ platform, docHeaders: interesting, inPage: signals }, null, 2));
} finally {
  await close();
}
