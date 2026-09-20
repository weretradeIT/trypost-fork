/**
 * Organic Activity Engine — X organic behaviors.
 *
 * Timeline scroll + like with API verification (Favorite_Tweet mutation).
 */

import { humanScroll, humanPause, humanMouseMove, humanClick, randInt } from './behavior.js';

export const FEED_URL = 'https://x.com/home';

/** Assert we are actually on the X timeline (not login/error page). */
function assertOnTimeline(page) {
  const url = page.url();
  if (!url.includes('x.com') || url.includes('login') || url.startsWith('chrome-error://')) {
    throw new Error(`Not on X timeline (at ${url || 'empty'}) — refusing to count scroll.`);
  }
}

export async function scrollTimeline(session) {
  const { page } = session;
  assertOnTimeline(page);
  const steps = randInt(3, 6);
  console.log(`[XOrganic] Scrolling timeline (${steps} steps)...`);
  const done = await humanScroll(page, { steps });
  return { scrolls: done };
}

/**
 * Like a couple of timeline tweets. Verified via the Favorite_Tweet GraphQL
 * mutation response. Returns { reactions }.
 */
export async function likeTimelinePosts(session, { maxReactions = 2 } = {}) {
  const { page } = session;
  const reactions = [];
  const targets = Math.min(maxReactions, randInt(1, 2));

  for (let i = 0; i < targets; i++) {
    try {
      const likeBtn = page
        .locator(
          [
            '[data-testid="like"]:not([data-testid="unlike"])',
            'button[data-testid="like"]',
          ].join(', ')
        )
        .nth(randInt(0, 3));

      const visible = await likeBtn.isVisible({ timeout: 4000 }).catch(() => false);
      if (!visible) {
        console.log('[XOrganic] No like button visible; scrolling more.');
        await humanScroll(page, { steps: 1 });
        continue;
      }

      const favResponse = page
        .waitForResponse(
          (res) =>
            (res.url().includes('/Favorite_Tweet') || res.url().includes('favorite_tweet')) &&
            res.request().method() === 'POST',
          { timeout: 12000 }
        )
        .catch(() => null);

      await humanMouseMove(page, likeBtn);
      await humanClick(page, likeBtn);
      console.log('[XOrganic] Clicked like; waiting for API confirmation...');

      const res = await favResponse;
      if (res && res.status() === 200) {
        reactions.push(res.url());
        console.log('[XOrganic] Reaction VERIFIED (200).');
      } else if (res) {
        console.warn(`[XOrganic] Favorite API answered ${res.status()}; not counted.`);
      } else {
        console.warn('[XOrganic] No Favorite_Tweet call intercepted; not counted.');
      }

      await humanPause(1200, 3500);
      await humanScroll(page, { steps: randInt(1, 2) });
    } catch (err) {
      console.warn(`[XOrganic] Like attempt ${i + 1} failed: ${err.message}`);
      await humanPause(800, 2000);
    }
  }

  return { reactions: reactions.length };
}
