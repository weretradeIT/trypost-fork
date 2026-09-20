/**
 * Organic Activity Engine — LinkedIn organic behaviors.
 *
 * Feed scroll + like/reactions that ONLY count when the like request is
 * confirmed by LinkedIn's Voyager API (HTTP 200 on the reaction endpoint).
 * This is the "verified organic signal" the guardrail requires.
 */

import { humanScroll, humanPause, humanMouseMove, humanClick, randInt } from './behavior.js';

export const FEED_URL = 'https://www.linkedin.com/feed/';

/** Assert we are actually on the LinkedIn feed (not authwall/error page). */
function assertOnFeed(page) {
  const url = page.url();
  if (!url.includes('www.linkedin.com') || url.includes('authwall') || url.includes('login') || url.startsWith('chrome-error://')) {
    throw new Error(`Not on LinkedIn feed (at ${url || 'empty'}) — refusing to count scroll.`);
  }
}

/**
 * Scroll the home feed like a reader. Returns { scrolls }.
 */
export async function scrollFeed(session) {
  const { page } = session;
  assertOnFeed(page);
  const steps = randInt(3, 6);
  console.log(`[LinkedInOrganic] Scrolling feed (${steps} steps)...`);
  const done = await humanScroll(page, { steps });
  return { scrolls: done };
}

/**
 * Try to like a small number of feed posts. A like only counts when the
 * Voyager reaction API answers 2xx — race the like click against the
 * network response.
 *
 * Returns { reactions } — number of VERIFIED reactions.
 */
export async function likeFeedPosts(session, { maxReactions = 2 } = {}) {
  const { page } = session;
  const reactions = [];
  const targets = Math.min(maxReactions, randInt(1, 2));

  for (let i = 0; i < targets; i++) {
    try {
      // React buttons live inside feed update articles.
      const likeBtn = page
        .locator(
          [
            'button[aria-label*="Gefällt mir"], button[aria-label*="Like"]',
            'button[aria-pressed="false"]:has([data-test-id="social-actions__reaction"])',
            'button.social-actions-button.social-actions__react-button',
          ].join(', ')
        )
        .nth(randInt(0, 2));

      const visible = await likeBtn.isVisible({ timeout: 4000 }).catch(() => false);
      if (!visible) {
        console.log('[LinkedInOrganic] No like button visible; scrolling a bit more.');
        await humanScroll(page, { steps: 1 });
        continue;
      }

      // Race the click against the Voyager reaction API call.
      const reactionResponse = page
        .waitForResponse(
          (res) =>
            res.url().includes('/voyager/api') &&
            (res.url().includes('Liking') || res.url().includes('Reaction')) &&
            res.request().method() === 'POST' ||
            (res.url().includes('/voyager/api/voyagerSocialDocumentLiking') && res.request().method() === 'PUT'),
          { timeout: 12000 }
        )
        .catch(() => null);

      await humanMouseMove(page, likeBtn);
      await humanClick(page, likeBtn);
      console.log('[LinkedInOrganic] Clicked like; waiting for API confirmation...');

      const res = await reactionResponse;
      if (res && res.status() >= 200 && res.status() < 300) {
        reactions.push(res.url());
        console.log(`[LinkedInOrganic] Reaction VERIFIED (${res.status()}).`);
      } else if (res) {
        console.warn(`[LinkedInOrganic] Reaction API answered ${res.status()}; not counted.`);
      } else {
        console.warn('[LinkedInOrganic] No reaction API call intercepted; not counted.');
      }

      // Scroll to the next post before possibly liking another.
      await humanPause(1200, 3500);
      await humanScroll(page, { steps: randInt(1, 2) });
    } catch (err) {
      console.warn(`[LinkedInOrganic] Like attempt ${i + 1} failed: ${err.message}`);
      await humanPause(800, 2000);
    }
  }

  return { reactions: reactions.length };
}
