/**
 * Organic Activity Engine — platform trap / challenge detector.
 *
 * A "trap" is the platform deciding we are a bot and serving us a non-content
 * page: a CAPTCHA, an auth checkpoint, a rate-limit / "unusual activity"
 * interstitial, an account restriction, or a login-wall bounce. If a live
 * action (warmup OR publish) lands on one of these, we MUST stop — continuing
 * to navigate/click from a trapped session is exactly the behaviour that
 * escalates a soft block into a hard ban, and it pollutes the ledger with
 * false "activity".
 *
 * This is deliberately PURE and string-based (url + page title + DOM markers)
 * so it can be unit-tested offline (no browser). It is called at the single
 * choke point every session flows through, and on every navigation the
 * publishers/sessions perform.
 *
 * Detection is multi-language (de/en) because the personas are German-locale
 * (de-DE) and LinkedIn/X localize their interstitials.
 */

/** URL path / host fragments that unambiguously mean "not a real feed". */
const TRAP_URL_PATTERNS = [
  // CAPTCHA / bot-verification
  /captcha/i,
  /\/challenge/i,
  /checkpoint/i,
  /authwall/i,
  /unusual-activity/i,
  /unusual_activity/i,
  /\/abuse\//i,
  // Login bounce (we were not, or are no longer, authenticated)
  /\/login/i,
  /i\/flow\/login/i,
  /\/auth\//i,
  // X-specific challenge / rate limit / restriction
  /\/i\/rate-limit/i,
  /\/i\/account\/restricted/i,
  /\/i\/account\/deactivated/i,
];

/** Visible text / title markers (multi-language de/en). */
const TRAP_TEXT_PATTERNS = [
  // CAPTCHA / verify-human
  /are you a robot/i,
  /not a robot/i,
  /verify you are human/i,
  /prove you are human/i,
  /ich bin kein roboter/i,
  /verifizieren sie, dass sie mensch/i,
  // checkpoint / unusual activity
  /checkpoint/i,
  /unusual activity/i,
  /ungewoehnliche aktivitaet/i,
  /ungewöhnliche aktivität/i,
  /your activity is unusual/i,
  /something doesn'?t look right/i,
  // rate limit
  /too many requests/i,
  /zu viele anfragen/i,
  /you'?re posting too quickly/i,
  // account restriction
  /account restricted/i,
  /account disabled/i,
  /your account has been locked/i,
  /konto eingeschränkt/i,
  /konto deaktiviert/i,
  /konto gesperrt/i,
];

/**
 * Detect a platform trap / challenge from a URL string.
 * @returns {string|null} a short reason, or null when the URL is clean.
 */
export function trapFromUrl(url) {
  const u = String(url || '');
  if (!u || u.startsWith('about:') || u.startsWith('data:')) return null;
  for (const re of TRAP_URL_PATTERNS) {
    if (re.test(u)) {
      return `trap url pattern ${re.source} (url=${u.slice(0, 120)})`;
    }
  }
  return null;
}

/**
 * Detect a platform trap / challenge from page title + body text.
 * @param {string} title    document.title
 * @param {string} bodyText visible body text (a few thousand chars is enough)
 * @returns {string|null} a short reason, or null when clean.
 */
export function trapFromText(title, bodyText) {
  const hay = `${title || ''}\n${bodyText || ''}`;
  for (const re of TRAP_TEXT_PATTERNS) {
    if (re.test(hay)) {
      return `trap text pattern ${re.source}`;
    }
  }
  return null;
}

/**
 * Combined trap check. `page` may be a Playwright page (has .url()/ .title()/
 * innerText) OR a plain object {url, title, bodyText} for offline testing.
 * @returns {{trapped: boolean, reason: string|null, url: string}}
 */
export function detectTrap(page) {
  let url = '';
  let title = '';
  let bodyText = '';

  if (typeof page === 'string') {
    url = page;
  } else if (page && typeof page.url === 'function') {
    // Playwright page (or a mock with a .url() function).
    url = page.url();
    if (typeof page.title === 'function') title = safeCall(page, 'title');
    if (typeof page.evaluate === 'function') {
      bodyText = '';
      // evaluate may not be present on plain mocks; caller can prefill.
    }
  } else if (page && typeof page.url === 'string') {
    url = page.url;
    title = page.title || '';
    bodyText = page.bodyText || '';
  }

  const urlReason = trapFromUrl(url);
  if (urlReason) return { trapped: true, reason: urlReason, url };
  const textReason = trapFromText(title, bodyText);
  if (textReason) return { trapped: true, reason: textReason, url };
  return { trapped: false, reason: null, url };
}

function safeCall(page, fn) {
  try {
    return page[fn]() || '';
  } catch {
    return '';
  }
}

/**
 * Cheap async probe of a live Playwright page that never throws: reads the
 * current url/title and a slice of visible text, then classifies. Returns
 * {trapped, reason, url} and NEVER rejects (callers rely on this in
 * finally-blocks and post-nav checks).
 */
export async function probePageForTrap(page) {
  try {
    const url = page.url();
    const title = await page.title().catch(() => '');
    const bodyText = await page
      .evaluate(() => document.body?.innerText?.slice(0, 4000) || '')
      .catch(() => '');
    return detectTrap({ url, title, bodyText });
  } catch (err) {
    // If even reading the page fails, treat as a soft trap so the caller
    // stops rather than hammering a dead session.
    let u = '';
    try {
      u = String(page.url ? page.url() : '');
    } catch {
      u = '';
    }
    return { trapped: true, reason: `probe failed: ${err.message}`, url: u };
  }
}
