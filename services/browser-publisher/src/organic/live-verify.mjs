// live-verify.mjs — ONE-SHOT live fingerprint verification (manual, operator-run).
//
// NOT part of the automated scheduler. Run deliberately, at most once per
// persona per day, to capture what the target origin's edge + in-page JS
// actually observe for the aligned identity (headers + the fingerprint wave).
//
//   node live-verify.mjs <platform:persona> [feedUrl]
//   e.g. node live-verify.mjs linkedin:hanna
//
// Behavior (exactly ONE session, human-paced, no burst):
//   1. openSession(allowPasswordLogin:true) → egress guardrail + residential
//      proxy + aligned identity + fingerprint wave.
//   2. ensureAuthenticated → redirect-loop retry, budgeted password login,
//      2FA/challenge, cookie refresh (production path).
//   3. Capture document request headers + in-page JS signals (incl. the new
//      userAgentData / connection / caches wave).
//   4. If authed: modest organic scroll (3 human steps) + honest ledger record.
//   5. saveState (persist refreshed cookies) + close. No further navigation.
//
// It is deliberately single-shot: repeated runs in a short window are exactly
// the pattern that triggers platform bot-detection, so run it sparingly.
import { openSession, ensureAuthenticated } from './session.js';
import { humanScroll, humanPause } from './behavior.js';
import { OrganicLedger } from './ledger.js';

const [, , accountArg = 'linkedin:hanna', feedUrlArg] = process.argv;
const [platform, persona] = accountArg.split(':');
if (!platform || !persona) {
  console.error('usage: node live-verify.mjs <platform:persona> [feedUrl]');
  process.exit(2);
}
const feedUrl = feedUrlArg ||
  (platform === 'x' ? 'https://x.com/home' : 'https://www.linkedin.com/feed/');

const account = { platform, persona, accountKey: `${platform}:${persona}` };
const ledger = new OrganicLedger();
const started = Date.now();

const session = await openSession(account, { allowPasswordLogin: true, ledger });
let result;
try {
  let docHeaders = null;
  session.page.on('request', (r) => {
    if (!docHeaders && r.resourceType() === 'document') docHeaders = r.headers();
  });

  const authed = await ensureAuthenticated(session, feedUrl, {});

  // Capture in-page signals — guarded so a dead/chrome-error page can't crash
  // the diagnostic (it then just reports what little is readable).
  const signals = await session.page.evaluate(() => {
    const uad = navigator.userAgentData;
    let highEntropy = null;
    try { highEntropy = uad ? uad.getHighEntropyValues(['architecture', 'bitness', 'platform', 'platformVersion', 'uaFullVersion']) : null; } catch (e) { highEntropy = 'ERR:' + e; }
    const conn = navigator.connection;
    return {
      url: location.href,
      title: document.title,
      ua: navigator.userAgent,
      platform: navigator.platform,
      languages: navigator.languages,
      userAgentData: uad ? { brands: uad.brands, mobile: uad.mobile, platform: uad.platform, fullVersionList: uad.fullVersionList, highEntropy } : null,
      connection: conn ? { effectiveType: conn.effectiveType, type: conn.type, downlink: conn.downlink, rtt: conn.rtt, saveData: conn.saveData } : null,
      deviceMemory: navigator.deviceMemory,
      hardwareConcurrency: navigator.hardwareConcurrency,
      plugins: navigator.plugins.length,
      mimeTypes: navigator.mimeTypes.length,
      hasWindowChrome: typeof window.chrome !== 'undefined',
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      outer: [window.outerWidth, window.outerHeight],
      inner: [window.innerWidth, window.innerHeight],
      screenXY: [window.screenX, window.screenY],
      onRealFeed: !/login|checkpoint|authwall|chrome-error|flow\/login/i.test(location.href) &&
        !!document.querySelector('.feed-shared-update-v2, .share-box-feed-entry, main[role=main] .scaffold-layout__content, [data-testid="primaryColumn"], [data-testid="tweetTextarea_0"]'),
    };
  }).catch((e) => ({ url: session.page.url(), evaluateError: String(e.message).split('\n')[0] }));

  let scrolls = 0;
  if (authed) {
    for (let i = 0; i < 3; i++) await humanScroll(session.page, { steps: 1, settleMs: [900, 2200], scrollSizes: [350, 700] });
    scrolls = 3;
    await humanPause(1500, 3000);
  }

  result = {
    ok: authed && scrolls > 0,
    authed,
    scrolls,
    reactions: 0,
    durationMs: Date.now() - started,
    engine: 'chromium',
    error: authed ? null : `not authenticated (url=${session.page.url()})`,
  };

  console.log(JSON.stringify({
    docHeaders: {
      'user-agent': docHeaders?.['user-agent'],
      'sec-ch-ua': docHeaders?.['sec-ch-ua'],
      'sec-ch-ua-mobile': docHeaders?.['sec-ch-ua-mobile'],
      'sec-ch-ua-platform': docHeaders?.['sec-ch-ua-platform'],
      'accept-language': docHeaders?.['accept-language'],
    },
    inPage: signals,
    result,
  }, null, 2));

  ledger.recordWarmup(account.accountKey, result);
  console.log('ledger recorded:', JSON.stringify(result));
  await session.saveState(); // persist any refreshed cookies
} finally {
  await session.close();
}
