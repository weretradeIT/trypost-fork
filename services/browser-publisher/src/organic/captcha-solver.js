/**
 * NopeCHA CAPTCHA Solver for trypost-browser-publisher
 * Uses NopeCHA Token API (requires paid API key; free IP-based tier only allows recognition, not token solving)
 * 
 * Environment variables (set in .env):
 *   NOPECHA_HANNA_KEY - API key for Hanna's sessions
 *   NOPECHA_BOB_KEY   - API key for Bob's sessions
 * 
 * Based on NopeCHA Token API docs:
 *   POST https://api.nopecha.com/token
 *   { type: 'recaptcha2', sitekey: '...', url: '...', key: 'YOUR_API_KEY' }
 *   -> { data: JOB_ID }
 *   GET https://api.nopecha.com/token?key=YOUR_API_KEY&id=JOB_ID
 *   -> { data: TOKEN_STRING } when ready
 */
class NopeCHASolver {
  constructor() {
    this.apiUrl = 'https://api.nopecha.com/token';
    this.pollIntervalMs = 5000;
    this.maxAttempts = 20; // ~100s timeout
  }

  /**
   * Get the appropriate API key based on current persona
   * @returns {string|null} API key or null if not configured
   */
  getApiKey() {
    // Try to determine persona from context - fallback to checking both
    // In practice, the bridge could pass persona via header or we check both env vars
    const hannaKey = process.env.NOPECHA_HANNA_KEY;
    const bobKey = process.env.NOPECHA_BOB_KEY;
    
    // For now, return whichever is set (should be configured per-agent)
    if (hannaKey) return hannaKey;
    if (bobKey) return bobKey;
    return null;
  }

  /**
   * Solve a CAPTCHA challenge using NopeCHA Token API
   * @param {string} type - 'recaptcha2', 'recaptcha3', 'hcaptcha', 'turnstile', etc.
   * @param {string} sitekey - The sitekey from the CAPTCHA widget
   * @param {string} url - The page URL where the CAPTCHA appears
   * @returns {Promise<string|null>} The token string or null if failed
   */
  async solve(type, sitekey, url) {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      console.warn('[nopecha] NOPECHA_KEY not configured. Cannot solve CAPTCHA programmatically.');
      return null;
    }

    try {
      // 1. Create solving task
      console.log(`[nopecha] Solving ${type} with sitekey ${sitekey} on ${url}`);
      const createResp = await fetch(this.apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          type,
          sitekey,
          url,
          key: apiKey
        })
      });

      const createData = await createResp.json();
      if (!createData || !createData.data) {
        console.error('[nopecha] Failed to create task:', createData);
        return null;
      }

      const jobId = createData.data;
      console.log(`[nopecha] Task created. Job ID: ${jobId}`);

      // 2. Poll for result
      for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
        await new Promise(resolve => setTimeout(resolve, this.pollIntervalMs));
        
        const resultResp = await fetch(`${this.apiUrl}?key=${apiKey}&id=${jobId}`);
        const resultData = await resultResp.json();
        
        if (!resultData || !resultData.data) {
          console.error('[nopecha] Failed to get result:', resultData);
          return null;
        }

        const token = resultData.data;
        if (token) {
          console.log(`[nopecha] CAPTCHA solved. Token length: ${token.length}`);
          return token;
        }
        
        // Token not ready yet, continue polling
        if (attempt % 4 === 0) { // Log every 20s
          console.log(`[nopecha] Waiting for solution... (attempt ${attempt + 1}/${this.maxAttempts})`);
        }
      }

      console.error('[nopecha] Timeout waiting for CAPTCHA solution');
      return null;
    } catch (err) {
      console.error('[nopecha] Error solving CAPTCHA:', err);
      return null;
    }
  }
}

module.exports = { NopeCHASolver };