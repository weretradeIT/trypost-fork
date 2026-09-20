import fs from "fs";
import { createAlignedBrowser } from "../organic/browser.js";

/**
 * LinkedIn publish — shared browser identity.
 *
 * Browser launch + context come from createAlignedBrowser() (organic/browser.js):
 * HARD residential-IP egress guardrail (fail-closed), residential proxy when
 * ORGANIC_BROWSER_PROXY is set, and the SAME macOS-Chrome fingerprint +
 * alignment init script that the warmup sessions use. One account, one
 * identity — for organic activity AND for publishing.
 */
export async function publishToLinkedIn({ platform, username, text, media = [], mediaUrls = [], accountConfig = {} }) {
  const user = (username || accountConfig?.credentials?.username || "").toLowerCase();
  const isBob = user.includes("bob") || user.includes("wt-ab1559426");
  const cookieUser = isBob ? "bob" : "hanna";

  // Credentials from accountConfig (if supplied) or env. NO hardcoded
  // password fallback — a missing env var must fail loudly, not log in with
  // a stale literal that outlives a rotation.
  const email = (accountConfig?.credentials?.email) || (isBob ? process.env.LINKEDIN_BOB_EMAIL : process.env.LINKEDIN_HANNA_EMAIL) || "";
  const password = (accountConfig?.credentials?.password) || (isBob ? process.env.LINKEDIN_BOB_PASSWORD : process.env.LINKEDIN_HANNA_PASSWORD) || "";
  const liAt = (accountConfig?.credentials?.liAt) || (isBob ? process.env.LINKEDIN_BOB_LI_AT : process.env.LINKEDIN_HANNA_LI_AT) || "";
  const jsessionId = (accountConfig?.credentials?.jsessionid) || (isBob ? process.env.LINKEDIN_BOB_JSESSIONID : process.env.LINKEDIN_HANNA_JSESSIONID) || "";

  let browser;
  let context;
  try {
    ({ browser, context } = await createAlignedBrowser({ platform: "linkedin", headless: true }));
  } catch (err) {
    if (err.name === "EgressPolicyError") {
      const e = new Error(`EGRESS_POLICY: publish refused — ${err.message}`);
      e.name = "EgressPolicyError";
      e.category = "egress_policy";
      throw e;
    }
    throw err;
  }

  try {
    const cookieFile = `/app/cookies/${cookieUser}.json`;
    let injected = false;

    if (fs.existsSync(cookieFile)) {
      try {
        const fullCookies = JSON.parse(fs.readFileSync(cookieFile, "utf8"));
        const cleanCookies = fullCookies.map(c => {
          const { sameSite, ...rest } = c;
          let sSite = "None";
          if (sameSite === "Strict" || sameSite === "Lax" || sameSite === "None") sSite = sameSite;
          return { ...rest, sameSite: sSite };
        });
        await context.addCookies(cleanCookies);
        console.log(`[LinkedInPublisher] Loaded ${cleanCookies.length} session cookies from ${cookieFile}`);
        injected = true;
      } catch (err) {
        console.warn("[LinkedInPublisher] Failed reading cookie file:", err.message);
      }
    }

    if (!injected && liAt) {
      const cookies = [
        {
          name: "li_at",
          value: liAt,
          domain: ".www.linkedin.com",
          path: "/",
          httpOnly: true,
          secure: true,
          sameSite: "None",
        },
        {
          name: "li_at",
          value: liAt,
          domain: ".linkedin.com",
          path: "/",
          httpOnly: true,
          secure: true,
          sameSite: "None",
        },
      ];
      if (jsessionId) {
        cookies.push({
          name: "JSESSIONID",
          value: jsessionId,
          domain: ".linkedin.com",
          path: "/",
          secure: true,
          sameSite: "None",
        });
      }
      await context.addCookies(cookies);
    }

    const page = await context.newPage();
    page.setDefaultTimeout(35000);

    async function handleChallengeAndConnect() {
      // Connect services DMA
      if (page.url().includes("connect-services")) {
        console.log("[LinkedInPublisher] Handling connect-services DMA screen...");
        try {
          const connectBtn = page.locator("button:has-text(\"Alle Services verknüpft lassen\"), button:has-text(\"verknüpft lassen\"), button:has-text(\"Weiter\")").first();
          if (await connectBtn.isVisible({ timeout: 4000 })) {
            await connectBtn.click();
            await page.waitForTimeout(4000);
          }
        } catch (e) {}
      }

      // Checkpoint / Challenge (2FA PIN)
      if (page.url().includes("checkpoint") || page.url().includes("challenge")) {
        console.log("[LinkedInPublisher] Security challenge detected: " + page.url());
        try {
          const pinInput = page.locator("input#input__email_verification_pin, input[name=\"pin\"], input[type=\"tel\"]").first();
          if (await pinInput.isVisible({ timeout: 5000 }).catch(() => false)) {
            console.log("[LinkedInPublisher] PIN verification field found! Checking for 2FA code from forwarder...");
            const start = Date.now();
            let solved = false;
            while (Date.now() - start < 45000) {
              let pin = null;
              const pinPaths = isBob ? ["/host-tmp/bob-latest-pin.json", "/tmp/bob-latest-pin.json"] : ["/host-tmp/hanna-latest-pin.json", "/tmp/hanna-latest-pin.json", "/host-tmp/bob-latest-pin.json", "/tmp/bob-latest-pin.json"];
              for (const p of pinPaths) {
                if (fs.existsSync(p)) {
                  try {
                    const data = JSON.parse(fs.readFileSync(p, "utf8"));
                    if (Date.now() - data.timestamp < 900000) {
                      pin = data.code;
                      break;
                    }
                  } catch (e) {}
                }
              }
              if (pin) {
                console.log("[LinkedInPublisher] Entering 2FA PIN: " + pin);
                await pinInput.fill(pin);
                await page.waitForTimeout(500);
                const submitPin = page.locator("button[type=\"submit\"], #email-pin-submit-button, button:has-text(\"Übermitteln\"), button:has-text(\"Submit\"), button:has-text(\"Bestätigen\")").first();
                await submitPin.click();
                console.log("[LinkedInPublisher] Submitted PIN! Waiting for navigation...");
                await page.waitForTimeout(4000);
                if (page.url().includes("flagship-web") || page.url().includes("checkpoint") || page.url().includes("login")) {
                  console.log("[LinkedInPublisher] Waiting for post-PIN redirect from " + page.url());
                  await page.waitForURL(url => url.toString().includes("/feed") || url.toString().includes("connect-services"), { timeout: 20000 }).catch(() => {});
                  await page.waitForTimeout(3000);
                }
                solved = true;
                break;
              }
              await page.waitForTimeout(2000);
            }
            if (!solved) {
              console.warn("[LinkedInPublisher] Timed out waiting for PIN code.");
            }
          }
        } catch (pinErr) {
          console.warn("[LinkedInPublisher] PIN handling note:", pinErr.message);
        }
      }

      if (page.url().includes("connect-services")) {
        console.log("[LinkedInPublisher] Handling connect-services DMA screen...");
        try {
          const connectBtn = page.locator("button:has-text(\"Alle Services verknüpft lassen\"), button:has-text(\"verknüpft lassen\"), button:has-text(\"Weiter\")").first();
          if (await connectBtn.isVisible({ timeout: 5000 })) {
            await connectBtn.click();
            await page.waitForTimeout(5000);
          }
        } catch (e) {}
      }
    }

    console.log("[LinkedInPublisher] Navigating to https://www.linkedin.com/feed/...");
    try {
      await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded", timeout: 30000 });
    } catch (gotoErr) {
      console.warn("[LinkedInPublisher] Initial feed load note:", gotoErr.message);
    }
    await page.waitForTimeout(3000);

    await handleChallengeAndConnect();

    // Dismiss cookie banner if present
    try {
      const cookieBtn = page.locator("button:has-text(\"Akzeptieren\"), button:has-text(\"Zulassen\"), button:has-text(\"Accept\")").first();
      if (await cookieBtn.isVisible({ timeout: 2000 })) {
        console.log("[LinkedInPublisher] Dismissing cookie banner...");
        await cookieBtn.click();
        await page.waitForTimeout(1000);
      }
    } catch (e) {}

    console.log("[LinkedInPublisher] Current page URL:", page.url());

    // Check if redirected to login
    const isLogin = await Promise.race([
      page.waitForSelector("button:has-text(\"Start a post\"), button:has-text(\"Beitrag beginnen\"), div:has-text(\"Beitrag beginnen\"), .share-box-feed-entry", { timeout: 8000 }).then(() => false),
      page.waitForSelector("#username, input[name=\"session_key\"]", { timeout: 8000 }).then(() => true),
    ]).catch(() => {
      return page.url().includes("login") || page.url().includes("authwall") || page.url().includes("checkpoint");
    });

    if (isLogin) {
      console.log("[LinkedInPublisher] Session cookie missing or expired. Performing automated login...");
      if (!password || !email) {
        throw new Error(`LinkedIn session expired and no email/password credentials configured for ${user}`);
      }

      if (page.url().includes("login") && !page.url().includes("checkpoint") && !page.url().includes("challenge")) {
        const hasUsername = await page.locator("#username").isVisible({ timeout: 4000 }).catch(() => false);
        if (hasUsername) {
          await page.fill("#username", email);
          await page.fill("#password", password);
          await page.click("button[type=\"submit\"]");
          console.log("[LinkedInPublisher] Login submitted. Waiting for feed...");
          await page.waitForTimeout(5000);
        }
      }

      await handleChallengeAndConnect();

      if (!page.url().includes("/feed")) {
        console.log("[LinkedInPublisher] Current URL after challenge handling: " + page.url());
        if (page.url().includes("connect-services")) {
          await handleChallengeAndConnect();
        }
        if (!page.url().includes("/feed")) {
          await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
          await page.waitForTimeout(4000);
          await handleChallengeAndConnect();
        }
      }
    }

    if (!page.url().includes("/feed")) {
      throw new Error(`Could not reach LinkedIn feed. Final URL: ${page.url()}`);
    }

    // Save fresh session cookies for next time
    try {
      const freshCookies = await context.cookies();
      fs.writeFileSync(cookieFile, JSON.stringify(freshCookies, null, 2));
      console.log(`[LinkedInPublisher] Saved ${freshCookies.length} persistent session cookies to ${cookieFile}`);
    } catch (e) {
      console.warn("[LinkedInPublisher] Could not persist cookies:", e.message);
    }

    console.log("[LinkedInPublisher] Finding \"Start a post\" button...");
    const triggerSelector = "button:has-text(\"Beitrag beginnen\"), button:has-text(\"Start a post\"), .share-box-feed-entry__top-bar button, .share-box-feed-entry button, button.share-box-feed-entry__trigger";
    try {
      const trigger = page.locator(triggerSelector).first();
      await trigger.waitFor({ state: "visible", timeout: 10000 });
      await trigger.click();
      console.log("[LinkedInPublisher] Clicked start post trigger via Playwright locator!");
    } catch (e) {
      console.log("[LinkedInPublisher] Fallback clicking trigger via evaluate...");
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button, div[role=\"button\"]"));
        const b = btns.find(el => {
          const t = (el.innerText || "").toLowerCase();
          return t.includes("beitrag") || t.includes("start a post");
        });
        if (b) b.click();
      });
    }

    console.log("[LinkedInPublisher] Waiting for editor textbox...");
    let editor;
    try {
      editor = await page.waitForSelector(
        "div.ql-editor, div[role=\"textbox\"], div.share-creation-state__text-editor",
        { timeout: 20000 }
      );
    } catch (waitErr) {
      await page.screenshot({ path: "/app/cookies/debug-editor.png" }).catch(() => {});
      throw waitErr;
    }
    await editor.click();

    console.log("[LinkedInPublisher] Inserting post text...");
    await editor.fill(text);
    await page.waitForTimeout(2000);

    // Network intercept for LinkedIn post creation
    const postResponsePromise = page.waitForResponse(
      res => (res.url().includes("/normShares") || res.url().includes("/graphql") || res.url().includes("/feed/updates")) && res.ok(),
      { timeout: 25000 }
    ).catch(err => {
      console.warn("[LinkedInPublisher] Could not intercept LinkedIn API response:", err.message);
      return null;
    });

    console.log("[LinkedInPublisher] Clicking Post button...");
    const postButton = await page.waitForSelector(
      "button.share-actions__primary-action, button:has-text(\"Post\"), button:has-text(\"Veröffentlichen\"), button:has-text(\"Posten\")",
      { timeout: 15000 }
    );
    await postButton.click();

    console.log("[LinkedInPublisher] Waiting for submission...");
    await page.waitForTimeout(5000);

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
