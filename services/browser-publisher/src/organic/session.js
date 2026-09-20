/**
 * Organic Activity Engine — shared browser session factory.
 *
 * ONE place that owns fingerprint, cookie loading/persisting, login and
 * challenge handling for each platform:persona. Warmup sessions and publish
 * sessions both go through here, so organic and publish traffic share the
 * same identity signature (viewport/UA/locale, same cookie jar).
 */

import { chromium } from 'playwright';
import fs from 'fs';
import { resolveAccount, cookieFileFor } from './accounts.js';
import { resolveCredentials } from '../credentials.js';
import { humanPause, randInt } from './behavior.js';
import { ORGANIC_CONFIG } from './config.js';
import { createAlignedBrowser } from './browser.js';

const CHALLENGE_PIN_WINDOW_MS = 15 * 60 * 1000;

function cookieSanitize(fullCookies) {
  return (fullCookies || []).map((c) => {
    const { sameSite, ...rest } = c;
    let sSite = 'None';
    if (sameSite === 'Strict' || sameSite === 'Lax' || sameSite === 'None') sSite = sameSite;
    return { ...rest, sameSite: sSite };
  });
}

async function loadCookiesFromFile(context, cookieFile) {
  if (!fs.existsSync(cookieFile)) return false;
  try {
    const fullCookies = JSON.parse(fs.readFileSync(cookieFile, 'utf8'));
    const clean = cookieSanitize(fullCookies);
    await context.addCookies(clean);
    console.log(`[OrganicSession] Loaded ${clean.length} session cookies from ${cookieFile}`);
    return true;
  } catch (err) {
    console.warn(`[OrganicSession] Failed reading cookie file: ${err.message}`);
    return false;
  }
}

async function injectTokenCookies(context, creds) {
  const cookies = [];
  if (creds.liAt) {
    for (const domain of ['.www.linkedin.com', '.linkedin.com']) {
      cookies.push({
        name: 'li_at',
        value: creds.liAt,
        domain,
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'None',
      });
    }
    if (creds.jsessionid) {
      cookies.push({
        name: 'JSESSIONID',
        value: creds.jsessionid,
        domain: '.linkedin.com',
        path: '/',
        secure: true,
        sameSite: 'None',
      });
    }
  }
  if (creds.authToken) {
    cookies.push({
      name: 'auth_token',
      value: creds.authToken,
      domain: '.x.com',
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'None',
    });
    if (creds.ct0) {
      cookies.push({ name: 'ct0', value: creds.ct0, domain: '.x.com', path: '/', secure: true, sameSite: 'Lax' });
    }
  }
  if (cookies.length) await context.addCookies(cookies);
  return cookies.length > 0;
}

async function saveCookies(context, cookieFile) {
  try {
    const fresh = await context.cookies();
    fs.writeFileSync(cookieFile, JSON.stringify(fresh, null, 2));
    console.log(`[OrganicSession] Saved ${fresh.length} session cookies to ${cookieFile}`);
  } catch (err) {
    console.warn(`[OrganicSession] Could not persist cookies: ${err.message}`);
  }
}

/**
 * Read a fresh 2FA PIN from the host-forwarder drop dirs (read-only /tmp mount).
 */
function readForwardedPin(persona) {
  const paths =
    persona === 'bob'
      ? ['/host-tmp/bob-latest-pin.json', '/tmp/bob-latest-pin.json']
      : ['/host-tmp/hanna-latest-pin.json', '/tmp/hanna-latest-pin.json', '/host-tmp/bob-latest-pin.json', '/tmp/bob-latest-pin.json'];
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) {
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (Date.now() - data.timestamp < CHALLENGE_PIN_WINDOW_MS) return data.code;
      }
    } catch {}
  }
  return null;
}

class OrganicSession {
  constructor(browser, context, page, account) {
    this.browser = browser;
    this.context = context;
    this.page = page;
    this.account = account;
  }

  url() {
    return this.page.url();
  }

  async saveState() {
    await saveCookies(this.context, cookieFileFor(this.account));
  }

  async close() {
    await this.browser.close().catch(() => {});
  }
}

/**
 * Open a session for platform:persona with cookies/token already applied.
 * Does NOT navigate — caller decides where to go.
 */
export async function openSession(account, { headless = true, allowPasswordLogin = false, ledger = null } = {}) {
  const platform = account.platform;
  const creds = resolveCredentials(platform, account.persona || 'corporate');
  const cookieFile = cookieFileFor(account);

  // Shared identity factory: HARD egress guardrail (fail-closed), residential
  // proxy if configured, per-platform UA/viewport/TZ, fingerprint init script.
  // Warmup and publish sessions both get the exact same browser identity.
  const { browser, context } = await createAlignedBrowser({ platform, headless });

  let hasAuth = await loadCookiesFromFile(context, cookieFile);
  if (!hasAuth) hasAuth = await injectTokenCookies(context, creds);

  const page = await context.newPage();
  page.setDefaultTimeout(35000);
  const session = new OrganicSession(browser, context, page, account);

  session.hasAuth = hasAuth;
  session.creds = creds;
  session.allowPasswordLogin = allowPasswordLogin;
  session.ledger = ledger;
  return session;
}

/**
 * Ensure we are authenticated on the target feed. Handles:
 *  - connect-services DMA screen (LinkedIn)
 *  - checkpoint / email-PIN challenge (2FA forwarder)
 *  - optional password login (only when allowPasswordLogin, budget-capped
 *    by the caller via the ledger — warmup logs in at most
 *    ORGANIC_WARMUP_MAX_LOGINS_PER_DAY times/day and only when necessary).
 *
 * Returns true when an authenticated feed is reachable.
 */
export async function ensureAuthenticated(session, feedUrl, { onLogin }) {
  const { page, account, creds } = session;

  // Navigating can land on chrome-error:// on transient redirect loops —
  // retry once with a clean page state before declaring failure.
  let navigated = false;
  for (let attempt = 1; attempt <= 2 && !navigated; attempt++) {
    try {
      await page.goto(feedUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      if (!isBrowserErrorPage(page)) navigated = true;
    } catch (err) {
      console.warn(`[OrganicSession] Navigation attempt ${attempt} note: ${err.message.split('\n')[0]}`);
    }
    if (!navigated && attempt === 1) {
      // Hard retry: sometimes ERR_TOO_MANY_REDIRECTS clears on a fresh load.
      await humanPause(1500, 3000);
    }
  }
  if (!navigated) {
    console.warn(`[OrganicSession] Feed unreachable (browser error page) for ${account.accountKey}: ${page.url()}`);
    // A stale cookie jar commonly produces an auth redirect loop that lands on
    // chrome-error://. That is NOT "no credentials" — it's "expired credentials".
    // If we may password-login (and have credentials + budget), fall through to
    // the login block below: linkedinPasswordLogin navigates to /login itself,
    // which clears the loop state. Only bail when we have no login path at all.
    if (!(session.allowPasswordLogin && creds.password && creds.email)) {
      return false;
    }
  } else {
    await humanPause(1500, 3000);
    await handleChallengeAndConnect(session);
    dismissCookieBanner(session);
  }

  // A real feed must BOTH not look logged out AND show a feed marker.
  const feedMarkerVisible = await page
    .locator(
      account.platform === 'linkedin'
        ? 'button:has-text("Start a post"), button:has-text("Beitrag beginnen"), .share-box-feed-entry, main[role="main"]'
        : '[data-testid="tweetTextarea_0"], div[role="textbox"][contenteditable="true"], [data-testid="AppTabBar_Profile_Link"], [data-testid="primaryColumn"]'
    )
    .first()
    .isVisible({ timeout: 6000 })
    .catch(() => false);

  if (!looksLoggedOut(page, account.platform) && feedMarkerVisible) {
    return true;
  }

  console.log(`[OrganicSession] Session expired for ${account.accountKey} (url=${page.url()}).`);

  // Password login (optional, budgeted by caller).
  if (session.allowPasswordLogin && creds.password && creds.email) {
    if (session.ledger && session.ledger.loginsToday(account.accountKey) >= 1) {
      console.warn(`[OrganicSession] Daily login budget exhausted for ${account.accountKey}; skipping password login.`);
      return false;
    }
    const ok =
      account.platform === 'linkedin'
        ? await linkedinPasswordLogin(session)
        : await xPasswordLogin(session);
    if (session.ledger) session.ledger.recordLogin(account.accountKey, { ok });
    onLogin?.(ok);
    if (ok) {
      await handleChallengeAndConnect(session);
      const markerVisible = await page
        .locator(
          account.platform === 'linkedin'
            ? 'button:has-text("Start a post"), button:has-text("Beitrag beginnen"), .share-box-feed-entry, main[role="main"]'
            : '[data-testid="tweetTextarea_0"], div[role="textbox"][contenteditable="true"], [data-testid="AppTabBar_Profile_Link"], [data-testid="primaryColumn"]'
        )
        .first()
        .isVisible({ timeout: 6000 })
        .catch(() => false);
      if (!looksLoggedOut(page, account.platform) && markerVisible) {
        await session.saveState();
        return true;
      }
    }
    return false;
  }

  return false;
}

function looksLoggedOut(page, platform) {
  const url = page.url();
  return (
    url.startsWith('chrome-error://') ||
    url.startsWith('about:') ||
    url.includes('login') ||
    url.includes('checkpoint') ||
    url.includes('authwall') ||
    url.includes('i/flow/login')
  );
}

/** A navigation that never produced a real document (ERR_TOO_MANY_REDIRECTS etc.). */
function isBrowserErrorPage(page) {
  const url = page.url();
  return url.startsWith('chrome-error://') || url.startsWith('about:') || url === '';
}

async function dismissCookieBanner(session) {
  const { page } = session;
  try {
    const cookieBtn = page
      .locator('button:has-text("Akzeptieren"), button:has-text("Zulassen"), button:has-text("Accept")')
      .first();
    if (await cookieBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      console.log('[OrganicSession] Dismissing cookie banner...');
      await cookieBtn.click();
      await humanPause(600, 1400);
    }
  } catch {}
}

async function handleChallengeAndConnect(session) {
  const { page, account } = session;

  // connect-services DMA screen (LinkedIn)
  if (page.url().includes('connect-services')) {
    console.log('[OrganicSession] Handling connect-services DMA screen...');
    try {
      const connectBtn = page
        .locator(
          'button:has-text("Alle Services verknüpft lassen"), button:has-text("verknüpft lassen"), button:has-text("Weiter")'
        )
        .first();
      if (await connectBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        await connectBtn.click();
        await humanPause(3000, 6000);
      }
    } catch {}
  }

  // Checkpoint / challenge (email PIN via forwarder)
  if (page.url().includes('checkpoint') || page.url().includes('challenge')) {
    console.log(`[OrganicSession] Security challenge detected: ${page.url()}`);
    try {
      const pinInput = page
        .locator('input#input__email_verification_pin, input[name="pin"], input[type="tel"]')
        .first();
      if (await pinInput.isVisible({ timeout: 5000 }).catch(() => false)) {
        console.log('[OrganicSession] PIN verification field found; polling forwarder...');
        const start = Date.now();
        let solved = false;
        while (Date.now() - start < 45000) {
          const pin = readForwardedPin(account.persona);
          if (pin) {
            console.log('[OrganicSession] Entering 2FA PIN from forwarder.');
            await pinInput.fill(pin);
            await humanPause(400, 900);
            const submit = page
              .locator(
                'button[type="submit"], #email-pin-submit-button, button:has-text("Übermitteln"), button:has-text("Submit"), button:has-text("Bestätigen")'
              )
              .first();
            await submit.click();
            await humanPause(3000, 5000);
            await page
              .waitForURL(
                (u) => u.toString().includes('/feed') || u.toString().includes('home'),
                { timeout: 20000 }
              )
              .catch(() => {});
            solved = true;
            break;
          }
          await humanPause(1800, 2600);
        }
        if (!solved) console.warn('[OrganicSession] Timed out waiting for PIN code.');
      }
    } catch (err) {
      console.warn(`[OrganicSession] PIN handling note: ${err.message}`);
    }
  }

  if (page.url().includes('connect-services')) {
    await dismissConnectScreen(session);
  }
}

async function dismissConnectScreen(session) {
  const { page } = session;
  try {
    const connectBtn = page
      .locator(
        'button:has-text("Alle Services verknüpft lassen"), button:has-text("verknüpft lassen"), button:has-text("Weiter")'
      )
      .first();
    if (await connectBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await connectBtn.click();
      await humanPause(4000, 7000);
    }
  } catch {}
}

async function linkedinPasswordLogin(session) {
  const { page, creds } = session;
  try {
    // If we're not on the login form, go there explicitly (fresh navigation
    // also clears redirect-loop state).
    const onLoginForm = await page
      .locator('#username')
      .isVisible({ timeout: 2000 })
      .catch(() => false);
    if (!onLoginForm) {
      await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded', timeout: 25000 });
      await humanPause(800, 1800);
    }
    const hasUsername = await page.locator('#username').isVisible({ timeout: 5000 }).catch(() => false);
    if (!hasUsername) {
      console.warn('[OrganicSession] LinkedIn login form not reachable (possible checkpoint ahead).');
      return false;
    }
    await page.fill('#username', creds.email);
    await humanPause(300, 900);
    await page.fill('#password', creds.password);
    await humanPause(400, 1100);
    await page.click('button[type="submit"]');
    console.log('[OrganicSession] LinkedIn login submitted; waiting for feed...');
    await humanPause(4000, 7000);
    await handleChallengeAndConnect(session);
    return !looksLoggedOut(page, 'linkedin');
  } catch (err) {
    console.warn(`[OrganicSession] LinkedIn password login failed: ${err.message}`);
    return false;
  }
}

async function xPasswordLogin(session) {
  const { page, creds } = session;
  try {
    if (!page.url().includes('x.com') || page.url().includes('login')) {
      await page.goto('https://x.com/i/flow/login', { waitUntil: 'networkidle', timeout: 25000 }).catch(() => {});
      await humanPause(900, 1800);
    }
    const userInput = await page.waitForSelector(
      'input[autocomplete="username"], input[name="text"]',
      { timeout: 10000 }
    );
    await userInput.fill(creds.username);
    await humanPause(300, 800);
    await page.keyboard.press('Enter');
    await humanPause(1500, 3000);

    const emailPrompt = await page.$('input[data-testid="ocfEnterTextTextInput"]');
    if (emailPrompt && creds.email) {
      await emailPrompt.fill(creds.email);
      await humanPause(300, 800);
      await page.keyboard.press('Enter');
      await humanPause(1500, 2500);
    }

    const passInput = await page.waitForSelector('input[name="password"]', { timeout: 10000 });
    await passInput.fill(creds.password);
    await humanPause(300, 800);
    await page.keyboard.press('Enter');
    await page.waitForURL((u) => !u.toString().includes('login'), { timeout: 20000 }).catch(() => {});
    return !looksLoggedOut(page, 'x');
  } catch (err) {
    console.warn(`[OrganicSession] X password login failed: ${err.message}`);
    return false;
  }
}
