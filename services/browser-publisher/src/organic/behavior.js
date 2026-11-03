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

// ---------------------------------------------------------------------------
//  Anti-bot v2 — Bézier kinematics, native keystroke synthesis, pre-warming
// ---------------------------------------------------------------------------

/**
 * Box–Muller Gaussian random with given mean and standard deviation.
 * @param {number} mean
 * @param {number} stddev
 * @returns {number}
 */
function gaussianRandom(mean, stddev) {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return mean + stddev * Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

/**
 * Log-normal sample — useful for inter-keystroke intervals which are
 * right-skewed (most fast, occasionally slow).
 * @param {number} mu   — log-space mean
 * @param {number} sigma — log-space standard deviation
 * @returns {number}
 */
function logNormalSample(mu, sigma) {
  return Math.exp(mu + sigma * gaussianRandom(0, 1));
}

/**
 * Module-level cursor position tracker, keyed by page/frame reference.
 * Falls back to viewport center when no prior position is known.
 * @type {WeakMap<object, {x: number, y: number}>}
 */
const _cursorPositions = new WeakMap();

/** @returns {{x: number, y: number}} */
function _getCursor(pageOrFrame) {
  if (_cursorPositions.has(pageOrFrame)) return _cursorPositions.get(pageOrFrame);
  const vp = (typeof pageOrFrame.viewportSize === 'function' && pageOrFrame.viewportSize()) || { width: 1280, height: 720 };
  return { x: vp.width / 2, y: vp.height / 2 };
}

function _setCursor(pageOrFrame, x, y) {
  _cursorPositions.set(pageOrFrame, { x, y });
}

/**
 * Evaluate a cubic Bézier curve at parameter t ∈ [0, 1].
 * @param {number} p0 @param {number} p1 @param {number} p2 @param {number} p3
 * @param {number} t
 * @returns {number}
 */
function _bezier(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

/**
 * Move the mouse along a cubic Bézier curve from (startX, startY) to
 * (targetX, targetY), simulating natural hand kinematics.
 *
 * - Two control points with perpendicular offset produce a natural arc.
 * - Fitts's Law governs total movement time.
 * - Ease-in-out timing (cosine) mimics acceleration → deceleration.
 * - Gaussian micro-jitter at 2-4 px simulates 8-12 Hz hand tremor.
 *
 * @param {import('playwright').Page | import('playwright').Frame} page
 * @param {number} startX
 * @param {number} startY
 * @param {number} targetX
 * @param {number} targetY
 * @param {object} [opts]
 * @param {number} [opts.targetWidth=20] — effective target width (Fitts's Law)
 * @param {number} [opts.a=50]           — Fitts's Law constant a (ms)
 * @param {number} [opts.b=150]          — Fitts's Law constant b (ms)
 * @param {number} [opts.jitterPx=3]     — micro-jitter amplitude (px)
 */
export async function humanBezierMove(page, startX, startY, targetX, targetY, opts = {}) {
  const { targetWidth = 20, a = 50, b = 150, jitterPx = 3 } = opts;

  const dx = targetX - startX;
  const dy = targetY - startY;
  const dist = Math.sqrt(dx * dx + dy * dy);

  // Number of intermediate steps scales with distance, ~8 px per step.
  const numSteps = Math.max(15, Math.min(40, Math.round(dist / 8)));

  // Fitts's Law total movement time.
  const movementTimeMs = a + b * Math.log2(dist / targetWidth + 1);

  // Perpendicular unit vector for control-point offset.
  const perpX = dist > 0 ? -dy / dist : 0;
  const perpY = dist > 0 ? dx / dist : 1;
  const arcOffset = gaussianRandom(0, dist * 0.25);

  // Two control points at ~1/3 and ~2/3 along the line, offset perpendicularly.
  const cp1x = startX + dx * 0.33 + perpX * arcOffset;
  const cp1y = startY + dy * 0.33 + perpY * arcOffset;
  const cp2x = startX + dx * 0.66 + perpX * arcOffset * 0.6;
  const cp2y = startY + dy * 0.66 + perpY * arcOffset * 0.6;

  const vp = (typeof page.viewportSize === 'function' && page.viewportSize()) || { width: 1280, height: 720 };

  for (let i = 1; i <= numSteps; i++) {
    const t = i / numSteps;
    // Ease-in-out via cosine interpolation.
    const tEased = 0.5 - 0.5 * Math.cos(t * Math.PI);

    let x = _bezier(startX, cp1x, cp2x, targetX, tEased);
    let y = _bezier(startY, cp1y, cp2y, targetY, tEased);

    // Micro-jitter (skip on the very last step to land precisely).
    if (i < numSteps) {
      x += gaussianRandom(0, jitterPx);
      y += gaussianRandom(0, jitterPx);
    }

    // Clamp to viewport.
    x = Math.max(1, Math.min(vp.width - 1, x));
    y = Math.max(1, Math.min(vp.height - 1, y));

    await page.mouse.move(x, y);

    // Inter-step delay derived from eased velocity profile.
    const stepDelay = movementTimeMs / numSteps;
    await sleep(Math.max(2, stepDelay + gaussianRandom(0, stepDelay * 0.15)));
  }

  _setCursor(page, targetX, targetY);
}

/**
 * Full Bézier-path click cycle on an element matched by `selector`.
 *
 * 1. Resolve element bounding rect and pick a Gaussian-jittered click point.
 * 2. Move from last known cursor position along a Bézier arc.
 * 3. Pre-click hover pause (30-80 ms).
 * 4. mousedown → dwell (40-120 ms) → slight position shift → mouseup.
 *
 * @param {import('playwright').Page | import('playwright').Frame} page
 * @param {string} selector
 * @param {object} [opts]
 * @param {string} [opts.frameUrl] — unused here, caller resolves the frame
 */
export async function humanBezierClick(page, selector, opts = {}) {
  if (!selector) throw new Error('humanBezierClick requires a selector');

  const box = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, selector);

  if (!box) {
    // Fallback: let Playwright handle the click natively.
    await page.click(selector);
    return;
  }

  // Gaussian-jittered click point within element bounds (±40 % from center).
  const clickX = box.x + box.width / 2 + gaussianRandom(0, box.width * 0.2);
  const clickY = box.y + box.height / 2 + gaussianRandom(0, box.height * 0.2);

  const vp = (typeof page.viewportSize === 'function' && page.viewportSize()) || { width: 1280, height: 720 };
  const clampedX = Math.max(1, Math.min(vp.width - 1, clickX));
  const clampedY = Math.max(1, Math.min(vp.height - 1, clickY));

  const cursor = _getCursor(page);
  await humanBezierMove(page, cursor.x, cursor.y, clampedX, clampedY, {
    targetWidth: Math.max(box.width, 8),
  });

  // Pre-click hover pause.
  await sleep(randInt(30, 80));

  // mousedown → dwell → slight shift → mouseup (replicating human micro-motion).
  await page.mouse.down();
  await sleep(randInt(40, 120));
  await page.mouse.move(clampedX + gaussianRandom(0, 1.5), clampedY + gaussianRandom(0, 1.5));
  await page.mouse.up();

  _setCursor(page, clampedX, clampedY);
}

// --- QWERTZ bi-gram typing model --------------------------------------------

/** Fast bi-grams that get a 35 % speed boost (common German / English pairs). */
const _FAST_BIGRAMS = new Set([
  'th', 'he', 'in', 'er', 'an', 'en', 'de', 'ei', 'nd', 'te',
  'ch', 'es', 'ge', 'ng', 'ie', 'un', 'st', 'be', 'au', 'ha',
]);

/** Keys typed with the left hand on a QWERTZ keyboard. */
const _LEFT_HAND = new Set('qwertasdfgyxcvb'.split(''));

/** Keys typed with the right hand on a QWERTZ keyboard. */
const _RIGHT_HAND = new Set('zuiopühjklöänm'.split(''));

/**
 * Adjacent keys on a German QWERTZ layout — used to simulate
 * occasional typo + backspace correction.
 * @type {Record<string, string[]>}
 */
const _QWERTZ_ADJACENT = {
  q: ['w', 'a'],       w: ['q', 'e', 's'],   e: ['w', 'r', 'd'],   r: ['e', 't', 'f'],
  t: ['r', 'z', 'g'],  z: ['t', 'u', 'h'],   u: ['z', 'i', 'j'],   i: ['u', 'o', 'k'],
  o: ['i', 'p', 'l'],  p: ['o', 'ü'],
  a: ['q', 's', 'y'],  s: ['a', 'w', 'd', 'x'], d: ['s', 'e', 'f', 'c'], f: ['d', 'r', 'g', 'v'],
  g: ['f', 't', 'h', 'b'], h: ['g', 'z', 'j', 'n'], j: ['h', 'u', 'k', 'm'], k: ['j', 'i', 'l'],
  l: ['k', 'o', 'ö'],
  y: ['a', 's', 'x'],  x: ['y', 's', 'd', 'c'], c: ['x', 'd', 'f', 'v'], v: ['c', 'f', 'g', 'b'],
  b: ['v', 'g', 'h', 'n'], n: ['b', 'h', 'j', 'm'], m: ['n', 'j', 'k'],
};

/**
 * Compute inter-key delay for a character given the previous character.
 * Uses log-normal base with bi-gram and same-hand adjustments.
 * @param {string} prev  — previous character ('' if first)
 * @param {string} cur   — current character
 * @returns {number} — delay in ms
 */
function _keystrokeDelay(prev, cur) {
  // Base delay: log-normal with median ~110 ms.
  let delay = logNormalSample(Math.log(110), 0.35);

  const lp = prev.toLowerCase();
  const lc = cur.toLowerCase();

  // Fast bi-gram boost.
  if (prev && _FAST_BIGRAMS.has(lp + lc)) {
    delay *= 0.65;
  }

  // Same-hand penalty.
  if (
    prev &&
    ((_LEFT_HAND.has(lp) && _LEFT_HAND.has(lc)) || (_RIGHT_HAND.has(lp) && _RIGHT_HAND.has(lc)))
  ) {
    delay *= 1.15;
  }

  // Clamp to 70-200 ms.
  return Math.max(70, Math.min(200, delay));
}

/**
 * Native keystroke synthesis with QWERTZ bi-gram latency model.
 *
 * Focuses the element via `humanBezierClick`, clears existing content with
 * Ctrl+A → Backspace, then types each character via `page.keyboard.press()`
 * producing trusted keydown / keypress / input / keyup events.
 *
 * - QWERTZ bi-gram model adjusts inter-key delay.
 * - Word-boundary pauses (100-500 ms) after space / punctuation.
 * - Occasional typo + backspace correction (2-3 % probability).
 * - Tab at end to trigger blur.
 *
 * @param {import('playwright').Page | import('playwright').Frame} page
 * @param {string} selector
 * @param {string} text
 * @param {object} [opts]
 * @param {number} [opts.typoProbability=0.025] — per-character typo probability
 */
export async function humanNativeType(page, selector, text, opts = {}) {
  const { typoProbability = 0.025 } = opts;

  // Focus via Bézier click (produces trusted pointer events).
  await humanBezierClick(page, selector);
  await sleep(randInt(50, 150));

  // Clear existing content: Ctrl+A → Backspace.
  await page.keyboard.press('Control+a');
  await sleep(randInt(30, 80));
  await page.keyboard.press('Backspace');
  await sleep(randInt(40, 120));

  let prevChar = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    // Occasional typo simulation (skip for space / punctuation).
    const lc = ch.toLowerCase();
    if (Math.random() < typoProbability && _QWERTZ_ADJACENT[lc]) {
      const adjacents = _QWERTZ_ADJACENT[lc];
      const wrong = adjacents[Math.floor(Math.random() * adjacents.length)];
      await page.keyboard.press(wrong);
      await sleep(randInt(80, 200));
      await page.keyboard.press('Backspace');
      await sleep(randInt(60, 150));
    }

    // Type the correct character.
    await page.keyboard.press(ch);

    // Inter-key delay.
    const delay = _keystrokeDelay(prevChar, ch);
    await sleep(delay);

    // Word-boundary pause after space or punctuation.
    if (' .,;:!?-'.includes(ch)) {
      await sleep(randInt(100, 500));
    }

    prevChar = ch;
  }

  // Tab out to trigger blur.
  await sleep(randInt(80, 200));
  await page.keyboard.press('Tab');
}

/**
 * Session pre-warming — generates ambient human activity to establish a
 * credible session fingerprint before any high-value interaction.
 *
 * Sequence: window focus → ambient mouse drift (60 %) → light scroll down →
 * reading pause → optional scroll back up.
 *
 * @param {import('playwright').Page} page
 * @param {number} [durationMs=3000] — total warm-up budget in ms
 */
export async function humanPreWarm(page, durationMs = 3000) {
  const start = Date.now();
  const remaining = () => Math.max(0, durationMs - (Date.now() - start));

  // Dispatch window focus event.
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); }).catch(() => {});

  // --- Phase 1: ambient mouse drift (60 % of budget) -------------------------
  const driftBudget = durationMs * 0.6;
  const vp = page.viewportSize() || { width: 1280, height: 720 };
  let cx = vp.width / 2 + gaussianRandom(0, 100);
  let cy = vp.height / 2 + gaussianRandom(0, 80);

  while (Date.now() - start < driftBudget && remaining() > 100) {
    cx += gaussianRandom(0, 40);
    cy += gaussianRandom(0, 30);
    cx = Math.max(10, Math.min(vp.width - 10, cx));
    cy = Math.max(10, Math.min(vp.height - 10, cy));
    await page.mouse.move(cx, cy);
    _setCursor(page, cx, cy);
    await sleep(randInt(80, 200));
  }

  // --- Phase 2: scroll down slightly (100-350 px in 3-8 steps) ---------------
  if (remaining() > 200) {
    const totalScroll = randInt(100, 350);
    const scrollSteps = randInt(3, 8);
    const perStep = Math.round(totalScroll / scrollSteps);
    for (let i = 0; i < scrollSteps && remaining() > 50; i++) {
      await page.mouse.wheel(0, perStep);
      await sleep(randInt(60, 180));
    }
  }

  // --- Phase 3: reading pause ------------------------------------------------
  if (remaining() > 200) {
    await sleep(Math.min(remaining() - 100, randInt(800, 2000)));
  }

  // --- Phase 4: optional scroll back up (50 % probability) -------------------
  if (Math.random() < 0.5 && remaining() > 200) {
    const upScroll = randInt(50, 200);
    const upSteps = randInt(2, 5);
    const perUp = Math.round(upScroll / upSteps);
    for (let i = 0; i < upSteps && remaining() > 40; i++) {
      await page.mouse.wheel(0, -perUp);
      await sleep(randInt(50, 150));
    }
  }
}
