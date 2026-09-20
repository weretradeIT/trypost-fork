/**
 * Organic Activity Engine — engine dispatcher (A/B layer).
 *
 * One entry point the warmup runner uses to get a browser session, regardless
 * of which engine is active:
 *
 *   chromium  — Playwright, shared identity factory (primary; full locator API
 *               + network-verified reactions).
 *   camofox   — CamoFox HTTP API (second layer; deeper in-browser fingerprint,
 *               verified-scroll mode).
 *
 * The A/B is controlled by ORGANIC_ENGINE (default 'chromium'). Switching is a
 * single env var — the warmup/scheduler/ledger/guardrail are all engine-
 * agnostic, so the same organic-behavior + guardrail + ledger machinery works
 * on both engines.
 */

import { ORGANIC_CONFIG } from './config.js';
import { openSession, ensureAuthenticated } from './session.js';
import { openCamofoxSession } from './camofox-engine.js';
import { scrollFeed, likeFeedPosts, FEED_URL as LI_FEED } from './linkedin.js';
import { scrollTimeline, likeTimelinePosts, FEED_URL as X_FEED } from './x.js';
import { humanDwell, humanPause, randInt } from './behavior.js';

export function activeEngine() {
  return ORGANIC_CONFIG.engine === 'camofox' ? 'camofox' : 'chromium';
}

/**
 * Run ONE organic warmup session for an account, on whatever engine is active.
 * Returns { ok, scrolls, reactions, error, engine }.
 *
 * This is the single function the scheduler and the /warmup endpoint call.
 * It fully replaces warmup.js's runWarmup() — the two now live here so the
 * engine switch is in one place.
 */
export async function runWarmupOnEngine(account, ledger) {
  const engine = activeEngine();
  const feedUrl = account.platform === 'linkedin' ? LI_FEED : X_FEED;
  const started = Date.now();

  if (engine === 'camofox') {
    return runWarmupCamofox(account, ledger, feedUrl, started);
  }
  return runWarmupChromium(account, ledger, feedUrl, started);
}

async function runWarmupChromium(account, ledger, feedUrl, started) {
  let session;
  try {
    console.log(`[Warmup:chromium] Organic session for ${account.accountKey}...`);
    session = await openSession(account, { headless: true, allowPasswordLogin: true, ledger });

    const authed = await ensureAuthenticated(session, feedUrl, {
      onLogin: (ok) => console.log(`[Warmup:chromium] Password login ${ok ? 'succeeded' : 'failed'}`),
    });
    if (!authed) {
      const r = { ok: false, scrolls: 0, reactions: 0, error: 'not authenticated', engine: 'chromium' };
      ledger.recordWarmup(account.accountKey, r);
      return r;
    }

    const scrollPhase =
      account.platform === 'linkedin' ? await scrollFeed(session) : await scrollTimeline(session);
    await humanDwell(session.page);

    let reactions = 0;
    const alreadyToday = ledger.reactionsToday(account.accountKey);
    const remaining = Math.max(0, ORGANIC_CONFIG.maxReactionsPerDay - alreadyToday);
    if (remaining > 0 && Math.random() < ORGANIC_CONFIG.reactionProbability) {
      const reactPhase =
        account.platform === 'linkedin'
          ? await likeFeedPosts(session, { maxReactions: Math.min(2, remaining) })
          : await likeTimelinePosts(session, { maxReactions: Math.min(2, remaining) });
      reactions = reactPhase.reactions;
    } else {
      console.log('[Warmup:chromium] Skipping reaction phase (probability/cap).');
    }

    if (Math.random() < 0.5) await humanDwell(session.page);
    await humanPause(500, 1500);
    await session.saveState();

    const r = { ok: true, scrolls: scrollPhase.scrolls, reactions, durationMs: Date.now() - started, engine: 'chromium' };
    ledger.recordWarmup(account.accountKey, r);
    return r;
  } catch (err) {
    const r = { ok: false, scrolls: 0, reactions: 0, error: err.message, engine: 'chromium' };
    ledger.recordWarmup(account.accountKey, r);
    return r;
  } finally {
    await session?.close();
  }
}

async function runWarmupCamofox(account, ledger, feedUrl, started) {
  let session;
  try {
    console.log(`[Warmup:camofox] Organic session for ${account.accountKey}...`);
    session = await openCamofoxSession(account, { feedUrl });

    const loggedOut = await session.looksLoggedOut();
    if (loggedOut) {
      // Honest: CamoFox has no password-login/2FA path yet — cookie import only.
      const r = { ok: false, scrolls: 0, reactions: 0, error: 'not authenticated (camofox cookie import; login not yet supported on this engine)', engine: 'camofox' };
      ledger.recordWarmup(account.accountKey, r);
      return r;
    }
    const scroll = await session.scrollVerified();
    console.log(`[Warmup:camofox] Verified scroll: ${scroll.scrolls}/${scroll.requested} steps advanced (scrollY=${scroll.scrollY}).`);

    const r = {
      ok: scroll.scrolls > 0,
      scrolls: scroll.scrolls,
      reactions: 0,
      durationMs: Date.now() - started,
      engine: 'camofox',
      note: 'verified-scroll mode (no network-verified reactions through CamoFox HTTP API)',
    };
    ledger.recordWarmup(account.accountKey, r);
    return r;
  } catch (err) {
    const r = { ok: false, scrolls: 0, reactions: 0, error: err.message, engine: 'camofox' };
    ledger.recordWarmup(account.accountKey, r);
    return r;
  } finally {
    await session?.close();
  }
}
