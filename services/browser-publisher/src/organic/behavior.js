/**
 * Organic Activity Engine — human behavior simulation primitives.
 *
 * Small, dependency-free helpers shared by the warmup sessions and (via the
 * session factory) by the publishers. Every delay is randomized; nothing here
 * should produce a machine-perfect rhythm.
 */

import { ORGANIC_CONFIG } from './config.js';

export const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Human-ish pause between actions. */
export function humanPause(minMs = 400, maxMs = 1600) {
  return sleep(randInt(minMs, maxMs));
}

/**
 * Move the mouse along a few jittered waypoints to a target element, then
 * click it. Falls back to a plain click when elementHandle is missing.
 */
export async function humanMouseMove(page, elementHandleOrLocator, opts = {}) {
  const vp = page.viewportSize() || { width: 1280, height: 720 };
  try {
    const el =
      typeof elementHandleOrLocator?.boundingBox === 'function'
        ? elementHandleOrLocator
        : elementHandleOrLocator?.elementHandle
          ? await elementHandleOrLocator.elementHandle()
          : elementHandleOrLocator;
    const box =
      typeof el?.boundingBox === 'function' ? await el.boundingBox().catch(() => null) : null;

    if (box) {
      const targetX = box.x + box.width / 2 + randInt(-box.width / 4, box.width / 4);
      const targetY = box.y + Math.min(box.height / 2, 30) + randInt(-5, 5);
      // 2–3 random waypoints before the target.
      const waypoints = randInt(2, 3);
      let curX = randInt(0, vp.width);
      let curY = randInt(0, vp.height);
      for (let i = 0; i < waypoints; i++) {
        const t = (i + 1) / (waypoints + 1);
        const x = curX + (targetX - curX) * t + randInt(-80, 80);
        const y = curY + (targetY - curY) * t + randInt(-60, 60);
        await page.mouse.move(Math.max(1, Math.min(vp.width - 1, x)), Math.max(1, Math.min(vp.height - 1, y)), {
          steps: randInt(5, 12),
        });
        await humanPause(80, 300);
        curX = x;
        curY = y;
      }
      await page.mouse.move(targetX, targetY, { steps: randInt(8, 18) });
      await humanPause(120, 450);
      return { targetX, targetY };
    }
  } catch {
    // Mouse path is best-effort; a straight click below is still fine.
  }
  return null;
}

/**
 * Click an element with a human mouse path. With a configured probability
 * this includes a CALCULATED MISCLICK: the first click lands offset from the
 * target (missing the hitbox), we pause like a human noticing, re-aim and
 * click correctly. Bots have a 100% hit rate; humans don't.
 */
export async function humanClick(page, elementHandleOrLocator, opts = {}) {
  const target = await humanMouseMove(page, elementHandleOrLocator, opts);

  const wantMisclick = Math.random() < ORGANIC_CONFIG.misclickProbability;
  if (wantMisclick && target) {
    const off = ORGANIC_CONFIG.misclickMaxOffsetPx;
    // Miss the hitbox: land outside the element's bounds but nearby —
    // the kind of near-miss a trackpad/mouse produces.
    const missX = target.targetX + (Math.random() < 0.5 ? -1 : 1) * (off * (0.6 + Math.random() * 0.4));
    const missY = target.targetY + (Math.random() < 0.5 ? -1 : 1) * (off * (0.6 + Math.random() * 0.4));
    const vp = page.viewportSize() || { width: 1280, height: 720 };
    await page.mouse.move(
      Math.max(1, Math.min(vp.width - 1, missX)),
      Math.max(1, Math.min(vp.height - 1, missY)),
      { steps: randInt(6, 14) }
    );
    await humanPause(80, 220); // press cadence
    await page.mouse.down();
    await humanPause(randInt(40, 110));
    await page.mouse.up();
    console.log('[Behavior] Misclick (calculated): landed offset, will re-aim.');
    // Human realizes the click didn't take effect: brief "huh" pause.
    await humanPause(250, 900);
    // Re-aim with a fresh micro-path and click for real.
    await humanMouseMove(page, elementHandleOrLocator, opts);
  }

  if (typeof elementHandleOrLocator?.click === 'function') {
    await elementHandleOrLocator.click({ delay: randInt(30, 90), ...opts });
  } else if (elementHandleOrLocator?.click) {
    await elementHandleOrLocator.click({ delay: randInt(30, 90) });
  } else {
    await page.mouse.click(opts.x ?? 0, opts.y ?? 0);
  }
  await humanPause();
}

/**
 * Scroll down in small, randomized, accelerating/decelerating increments —
 * like a person skimming a feed. Returns the number of scroll steps taken.
 */
export async function humanScroll(page, { steps, settleMs = [600, 2200], scrollSizes = [220, 520] } = {}) {
  const n = steps ?? randInt(3, 6);
  for (let i = 0; i < n; i++) {
    const dy = randInt(scrollSizes[0], scrollSizes[1]);
    await page.mouse.wheel(0, dy).catch(() => page.evaluate((y) => window.scrollBy(0, y), dy));
    await humanPause(settleMs[0], settleMs[1]);
    // Occasional scroll-up "re-read" twitch.
    if (Math.random() < 0.15 && i > 0) {
      await page.mouse.wheel(0, -randInt(60, 180)).catch(() => {});
      await humanPause(200, 700);
    }
  }
  return n;
}

/**
 * Read-like dwell: sometimes hover over a headline-ish element, sometimes just
 * idle. Keeps the session from being a pure scroll-timeline pattern.
 */
export async function humanDwell(page) {
  const mode = Math.random();
  try {
    if (mode < 0.4) {
      // Hover something in the middle of the viewport.
      const vp = page.viewportSize() || { width: 1280, height: 720 };
      await page.mouse.move(randInt(100, vp.width - 100), randInt(120, vp.height - 120), { steps: randInt(6, 15) });
      await humanPause(500, 2000);
    } else if (mode < 0.6) {
      await humanScroll(page, { steps: 1 });
    } else {
      await humanPause(800, 3000);
    }
  } catch {
    await humanPause(400, 1200);
  }
}
