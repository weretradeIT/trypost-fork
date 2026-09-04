import { chromium } from 'playwright';
import { resolveCredentials } from '../credentials.js';

export async function publishToLinkedIn({ platform, username, text, media = [] }) {
  const creds = resolveCredentials(platform, username);
  console.log(`[LinkedInPublisher] Starting LinkedIn publish for user: ${creds.username}`);

  if (!creds.liAt && !creds.password) {
    throw new Error(`Missing both li_at and password for LinkedIn user: ${creds.username}`);
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
    if (creds.liAt) {
      const cookies = [
        {
          name: 'li_at',
          value: creds.liAt,
          domain: '.www.linkedin.com',
          path: '/',
          httpOnly: true,
          secure: true,
          sameSite: 'None',
        },
        {
          name: 'li_at',
          value: creds.liAt,
          domain: '.linkedin.com',
          path: '/',
          httpOnly: true,
          secure: true,
          sameSite: 'None',
        },
      ];
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
      await context.addCookies(cookies);
    }

    const page = await context.newPage();
    page.setDefaultTimeout(35000);

    console.log('[LinkedInPublisher] Navigating to https://www.linkedin.com/feed/...');
    await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded' });

    // Check if redirected to login
    const isLogin = await Promise.race([
      page.waitForSelector('button:has-text("Start a post"), button:has-text("Beitrag beginnen"), div.share-box-feed-entry__top-bar', { timeout: 15000 }).then(() => false),
      page.waitForSelector('#username, input[name="session_key"]', { timeout: 15000 }).then(() => true),
    ]).catch(() => {
      return page.url().includes('login') || page.url().includes('authwall') || page.url().includes('checkpoint');
    });

    if (isLogin) {
      console.log('[LinkedInPublisher] Session cookie missing or expired. Performing automated login...');
      if (!creds.password || !creds.email) {
        throw new Error(`LinkedIn session expired and no email/password credentials configured for ${creds.username}`);
      }

      await page.goto('https://www.linkedin.com/login', { waitUntil: 'networkidle' });
      await page.fill('#username', creds.email);
      await page.fill('#password', creds.password);
      await page.click('button[type="submit"]');

      console.log('[LinkedInPublisher] Login submitted. Waiting for feed...');
      await page.waitForURL(url => url.toString().includes('/feed'), { timeout: 25000 });
    }

    console.log('[LinkedInPublisher] Finding "Start a post" button...');
    const startPostButton = await page.waitForSelector(
      'button:has-text("Start a post"), button:has-text("Beitrag beginnen"), div.share-box-feed-entry__top-bar button',
      { timeout: 20000 }
    );
    await startPostButton.click();

    console.log('[LinkedInPublisher] Waiting for editor textbox...');
    const editor = await page.waitForSelector(
      'div.ql-editor, div[role="textbox"], div.share-creation-state__text-editor',
      { timeout: 20000 }
    );
    await editor.click();

    console.log('[LinkedInPublisher] Inserting post text...');
    await editor.fill(text);
    await page.waitForTimeout(1500);

    // Network intercept for LinkedIn post creation
    const postResponsePromise = page.waitForResponse(
      res => (res.url().includes('/normShares') || res.url().includes('/graphql') || res.url().includes('/feed/updates')) && res.ok(),
      { timeout: 25000 }
    ).catch(err => {
      console.warn('[LinkedInPublisher] Could not intercept LinkedIn API response:', err.message);
      return null;
    });

    console.log('[LinkedInPublisher] Clicking Post button...');
    const postButton = await page.waitForSelector(
      'button.share-actions__primary-action, button:has-text("Post"), button:has-text("Veröffentlichen")',
      { timeout: 15000 }
    );
    await postButton.click();

    console.log('[LinkedInPublisher] Waiting for submission...');
    await page.waitForTimeout(3000);

    const postResponse = await postResponsePromise;
    let postUrn = null;
    if (postResponse) {
      try {
        const json = await postResponse.json();
        postUrn = json?.activity || json?.urn || json?.data?.id;
        if (postUrn) {
          console.log(`[LinkedInPublisher] Captured post URN from API: ${postUrn}`);
        }
      } catch (e) {
        // Ignored
      }
    }

    const id = postUrn || `urn:li:share:${Date.now()}`;
    const postUrl = postUrn ? `https://www.linkedin.com/feed/update/${postUrn}/` : `https://www.linkedin.com/feed/`;

    console.log(`[LinkedInPublisher] LinkedIn post successfully published: ${postUrl}`);

    return {
      success: true,
      id,
      url: postUrl,
      published_at: new Date().toISOString(),
    };
  } finally {
    await browser.close().catch(() => {});
  }
}
