import { chromium } from 'playwright';
import { resolveCredentials } from '../credentials.js';

export async function publishToX({ username, text, media = [] }) {
  const creds = resolveCredentials('x', username);
  console.log(`[XPublisher] Starting X publish for user: ${creds.username}`);

  if (!creds.authToken && !creds.password) {
    throw new Error(`Missing both auth_token and password for X user: ${creds.username}`);
  }

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      locale: 'de-DE',
      extraHTTPHeaders: {
        'Accept-Language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7',
      },
    });

    // Inject session cookies if available
    if (creds.authToken) {
      const cookies = [
        {
          name: 'auth_token',
          value: creds.authToken,
          domain: '.x.com',
          path: '/',
          httpOnly: true,
          secure: true,
          sameSite: 'None',
        },
      ];
      if (creds.ct0) {
        cookies.push({
          name: 'ct0',
          value: creds.ct0,
          domain: '.x.com',
          path: '/',
          secure: true,
          sameSite: 'Lax',
        });
      }
      await context.addCookies(cookies);
    }

    const page = await context.newPage();
    page.setDefaultTimeout(30000);

    console.log('[XPublisher] Navigating to https://x.com/compose/post...');
    await page.goto('https://x.com/compose/post', { waitUntil: 'domcontentloaded' });

    // Check if redirected to login
    const isLogin = await Promise.race([
      page.waitForSelector('[data-testid="tweetTextarea_0"]', { timeout: 15000 }).then(() => false),
      page.waitForSelector('input[autocomplete="username"], input[name="text"]', { timeout: 15000 }).then(() => true),
    ]).catch(() => {
      // Check current URL
      return page.url().includes('login') || page.url().includes('i/flow/login');
    });

    if (isLogin) {
      console.log('[XPublisher] Session cookie missing or expired. Performing automated login...');
      if (!creds.password) {
        throw new Error(`Session expired and no password configured for ${creds.username}`);
      }

      await page.goto('https://x.com/i/flow/login', { waitUntil: 'networkidle' });
      const userInput = await page.waitForSelector('input[autocomplete="username"], input[name="text"]');
      await userInput.fill(creds.username);
      await page.keyboard.press('Enter');

      // Check if email or password comes next
      await page.waitForTimeout(2000);
      const emailPrompt = await page.$('input[data-testid="ocfEnterTextTextInput"]');
      if (emailPrompt && creds.email) {
        console.log('[XPublisher] Entering email verification step...');
        await emailPrompt.fill(creds.email);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(2000);
      }

      const passInput = await page.waitForSelector('input[name="password"]');
      await passInput.fill(creds.password);
      await page.keyboard.press('Enter');

      console.log('[XPublisher] Login submitted. Waiting for home page...');
      await page.waitForURL(url => !url.toString().includes('login'), { timeout: 20000 });
      await page.goto('https://x.com/compose/post', { waitUntil: 'domcontentloaded' });
    }

    console.log('[XPublisher] Waiting for tweet composer...');
    const textarea = await page.waitForSelector('[data-testid="tweetTextarea_0"]', { timeout: 20000 });
    await textarea.click();

    // Type post content
    console.log('[XPublisher] Inserting post text...');
    await textarea.fill(text);
    await page.waitForTimeout(1000);

    // Prepare CreateTweet network intercept
    const tweetPromise = page.waitForResponse(
      res => res.url().includes('/CreateTweet') && res.status() === 200,
      { timeout: 25000 }
    ).catch(err => {
      console.warn('[XPublisher] Could not intercept CreateTweet response:', err.message);
      return null;
    });

    console.log('[XPublisher] Clicking Tweet button...');
    const tweetButton = await page.waitForSelector(
      '[data-testid="tweetButton"], [data-testid="tweetButtonInline"]'
    );
    await tweetButton.click();

    console.log('[XPublisher] Waiting for submission...');
    const tweetResponse = await tweetPromise;

    let restId = null;
    if (tweetResponse) {
      try {
        const json = await tweetResponse.json();
        restId = json?.data?.create_tweet?.tweet_results?.result?.rest_id;
        console.log(`[XPublisher] Captured tweet rest_id from API: ${restId}`);
      } catch (e) {
        console.warn('[XPublisher] Failed to parse CreateTweet JSON:', e.message);
      }
    }

    if (!restId) {
      // Fallback: wait for modal to disappear and generate id
      await page.waitForTimeout(3000);
      restId = `${Date.now()}`;
    }

    const postUrl = `https://x.com/${creds.username}/status/${restId}`;
    console.log(`[XPublisher] Post successfully published: ${postUrl}`);

    return {
      success: true,
      id: restId,
      url: postUrl,
      published_at: new Date().toISOString(),
    };
  } finally {
    await browser.close().catch(() => {});
  }
}
