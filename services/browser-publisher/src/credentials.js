/**
 * Credentials resolver for TryPost Browser Publisher Bridge.
 * Resolves session tokens (cookies) and login credentials for personas (Hanna, Bob, Corporate).
 */

export function resolveCredentials(platform, username = '') {
  const normUser = String(username).toLowerCase().trim();

  if (platform === 'x') {
    // Hanna Thoma
    if (normUser.includes('hanna')) {
      return {
        platform: 'x',
        username: 'weretradeHanna',
        authToken: process.env.X_HANNA_AUTH_TOKEN || process.env.X_AUTH_TOKEN || '',
        ct0: process.env.X_HANNA_CT0 || process.env.X_CT0 || '',
        email: process.env.X_HANNA_EMAIL || 'hanna.t0710@gmail.com',
        password: process.env.X_HANNA_PASSWORD || '',
      };
    }

    // Bob Weber
    if (normUser.includes('bob')) {
      return {
        platform: 'x',
        username: 'bob_w1408',
        authToken: process.env.X_BOB_AUTH_TOKEN || '',
        ct0: process.env.X_BOB_CT0 || '',
        email: process.env.X_BOB_EMAIL || 'bob.weber1408@gmail.com',
        password: process.env.X_BOB_PASSWORD || '',
      };
    }

    // Corporate / Default fallback
    return {
      platform: 'x',
      username: username || 'weretrade',
      authToken: process.env.X_AUTH_TOKEN || '',
      ct0: process.env.X_CT0 || '',
      email: process.env.X_EMAIL || '',
      password: process.env.X_PASSWORD || '',
    };
  }

  if (platform === 'linkedin' || platform === 'linkedin-page') {
    // Hanna Thoma
    if (normUser.includes('hanna')) {
      return {
        platform: 'linkedin',
        username: username || 'hanna-thoma',
        liAt: process.env.LINKEDIN_HANNA_LI_AT || process.env.LINKEDIN_LI_AT || '',
        jsessionid: process.env.LINKEDIN_HANNA_JSESSIONID || '',
        email: process.env.LINKEDIN_HANNA_EMAIL || 'hanna.t0710@gmail.com',
        password: process.env.LINKEDIN_HANNA_PASSWORD || '',
      };
    }

    // Bob Weber
    if (normUser.includes('bob')) {
      return {
        platform: 'linkedin',
        username: username || 'bob-weber',
        liAt: process.env.LINKEDIN_BOB_LI_AT || '',
        jsessionid: process.env.LINKEDIN_BOB_JSESSIONID || '',
        email: process.env.LINKEDIN_BOB_EMAIL || 'bob.weber@weretrade.com',
        password: process.env.LINKEDIN_BOB_PASSWORD || '',
      };
    }

    // Corporate / Default fallback
    return {
      platform: 'linkedin',
      username: username || 'weretradeit',
      liAt: process.env.LINKEDIN_LI_AT || '',
      jsessionid: process.env.LINKEDIN_JSESSIONID || '',
      email: process.env.LINKEDIN_EMAIL || '',
      password: process.env.LINKEDIN_PASSWORD || '',
    };
  }

  throw new Error(`Unsupported platform: ${platform}`);
}
