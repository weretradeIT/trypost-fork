/**
 * Organic Activity Engine — configuration.
 *
 * All knobs are env-driven with safe defaults so the bridge boots unchanged
 * on hosts that don't set any ORGANIC_* variables.
 */

function num(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const v = Number(raw);
  return Number.isFinite(v) ? v : def;
}

function bool(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

function csv(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  return String(raw)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export const ORGANIC_CONFIG = {
  // --- Warmup scheduler -------------------------------------------------
  enabled: bool('ORGANIC_WARMUP_ENABLED', true),
  tickMinutes: num('ORGANIC_WARMUP_TICK_MINUTES', 5),
  minIntervalHours: num('ORGANIC_WARMUP_MIN_INTERVAL_H', 3),
  maxIntervalHours: num('ORGANIC_WARMUP_MAX_INTERVAL_H', 7),
  // Quiet hours in the account's local timezone (no sessions inside).
  timezone: process.env.ORGANIC_WARMUP_TIMEZONE || 'Europe/Berlin',
  // Chrome major for the fingerprint identity. MUST match browser.js's
  // CHROME_MAJOR (same env var) so the UA, Sec-Ch-Ua header, and
  // navigator.userAgentData all agree on the same version.
  chromeMajor: process.env.ORGANIC_CHROME_MAJOR || '151',
  quietHourStart: num('ORGANIC_WARMUP_QUIET_START', 23),
  quietHourEnd: num('ORGANIC_WARMUP_QUIET_END', 6),
  // Failure backoff.
  failureBackoffMinH: num('ORGANIC_WARMUP_FAIL_BACKOFF_MIN_H', 1),
  failureBackoffMaxH: num('ORGANIC_WARMUP_FAIL_BACKOFF_MAX_H', 3),
  // Login (password) attempts are capped per account per day.
  maxPasswordLoginsPerDay: num('ORGANIC_WARMUP_MAX_LOGINS_PER_DAY', 1),

  // --- Session behavior -------------------------------------------------
  minScrollSteps: num('ORGANIC_WARMUP_SCROLL_MIN', 3),
  maxScrollSteps: num('ORGANIC_WARMUP_SCROLL_MAX', 6),
  reactionProbability: num('ORGANIC_WARMUP_REACTION_PROB', 0.6),
  maxReactionsPerDay: num('ORGANIC_WARMUP_MAX_REACTIONS_PER_DAY', 3),

  // --- Guardrail --------------------------------------------------------
  guardrailEnabled: bool('ORGANIC_GUARDRAIL_ENABLED', true),
  // A publish requires a scroll session within this window…
  maxScrollAgeHours: num('ORGANIC_GUARDRAIL_SCROLL_MAX_AGE_H', 24),
  // …and at least one verified reaction within this window.
  requireReaction: bool('ORGANIC_GUARDRAIL_REQUIRE_REACTION', true),
  maxReactionAgeHours: num('ORGANIC_GUARDRAIL_REACTION_MAX_AGE_H', 72),
  // Only these personas are enforced (comma separated). Corporate accounts pass.
  enforcedPersonas: csv('ORGANIC_GUARDRAIL_PERSONAS', ['hanna', 'bob']),

  // --- Egress (residential IP) guardrail ---------------------------------
  // HARD fail-closed: no browser session may touch a platform from a
  // datacenter IP. lair404 sits on Hetzner — without a residential proxy
  // every session would egress from a blocklisted ASN.
  egressEnforce: bool('ORGANIC_EGRESS_ENFORCE', true),
  egressAllowlist: csv('ORGANIC_EGRESS_ALLOWLIST', []),
  egressDcKeywords: csv('ORGANIC_EGRESS_DC_KEYWORDS', [
    'hetzner', 'ovh', 'digitalocean', 'linode', 'vultr', 'amazon', 'aws',
    'google llc', 'microsoft', 'azure', 'oracle', 'cloud', 'hosting',
    'server', 'datacamp', 'contabo', 'scaleway', 'leaseweb', 'choopa',
    'colocation', 'coloc', 'm247', 'ipxo', 'packet',
  ]),
  egressCacheMinutes: num('ORGANIC_EGRESS_CACHE_MINUTES', 60),
  // Proxy that the actual browser sessions should use, e.g.
  // http://user:pass@residential-host:8080 or socks5://…
  browserProxy: process.env.ORGANIC_BROWSER_PROXY || '',

  // --- Human imperfection ---------------------------------------------------
  // Calculated misclicks: humans sometimes click next to the target, hit the
  // wrong element, correct themselves. bots never miss.
  misclickProbability: num('ORGANIC_MISCCLICK_PROB', 0.12),
  misclickMaxOffsetPx: num('ORGANIC_MISCCLICK_MAX_OFFSET_PX', 120),

  // --- Browser engine (A/B layer) -----------------------------------------
  // 'chromium' (Playwright, primary — full locator + network-verified reactions)
  // or 'camofox' (CamoFox HTTP API — deeper in-browser fingerprinting: real
  // Firefox TLS/JA3, WebRTC blocked, fonts; verified-scroll mode, no
  // network-verified reactions through the HTTP API). The whole point of the
  // A/B is to test whether a DIFFERENT browser engine (different TLS stack)
  // gets better platform reception.
  engine: (process.env.ORGANIC_ENGINE || 'chromium').toLowerCase(),
  // CamoFox HTTP endpoint + auth (the shared camofox-browser container).
  camofoxBaseUrl: process.env.ORGANIC_CAMOFOX_BASE_URL || 'http://100.100.10.10:9377',
  camofoxApiKey: process.env.ORGANIC_CAMOFOX_API_KEY || process.env.CAMOFOX_API_KEY || '',
  // How many scroll steps the CamoFox verified-scroll warmup performs.
  camofoxScrollSteps: num('ORGANIC_CAMOFOX_SCROLL_STEPS', 5),

  // --- Live-action integrity gate ------------------------------------------
  // BEFORE any live action (warmup OR publish) opens a browser session, a
  // per-session measurement integrity check runs: it verifies the active
  // measurement stack (residential-IP egress, aligned client-hints, in-page
  // fingerprint patch, WebRTC lockdown) is actually ACTIVE and correctly
  // configured, and refuses the session if a measurement is missing. This is
  // the "100% sure every measurement is on before we touch a live account"
  // guard — it lives in the ONE choke point every session flows through
  // (createAlignedBrowser), so it covers hanna/bob AND any future persona
  // with zero per-platform call-site changes.
  //   liveActionIntegrityEnabled   — master switch (fail-closed when true).
  //   liveActionRequireResidential — a live action needs a RESIDENTIAL egress
  //                                   (datacenter IP alone is never enough).
  //   liveActionRequireAlignedHints— a live action needs the aligned
  //                                   sec-ch-ua (no HeadlessChrome brand).
  //   liveActionRequireFingerprint — a live action needs the in-page
  //                                   fingerprint patch to be injected.
  //   liveActionRequireWebrtc      — a live action needs WebRTC locked to the
  //                                   proxy (no host-IP leak).
  liveActionIntegrityEnabled: bool('ORGANIC_LIVE_ACTION_INTEGRITY_ENABLED', true),
  liveActionRequireResidential: bool('ORGANIC_LIVE_ACTION_REQUIRE_RESIDENTIAL', true),
  liveActionRequireAlignedHints: bool('ORGANIC_LIVE_ACTION_REQUIRE_ALIGNED_HINTS', true),
  liveActionRequireFingerprint: bool('ORGANIC_LIVE_ACTION_REQUIRE_FINGERPRINT', true),
  liveActionRequireWebrtc: bool('ORGANIC_LIVE_ACTION_REQUIRE_WEBRTC', true),

  // --- Managed personas (generalization beyond hanna/bob) ------------------
  // The organic engine is persona-generic. PERSONA_PATTERNS in accounts.js
  // maps username→persona; this CSV is the ADDITIONAL set of persona slugs
  // that should be actively managed (scheduled warmups + guardrail) on top of
  // the built-in hanna/bob. To add a new synthetic persona for future
  // automated web actions: (1) add its username→persona needle to
  // accounts.js PERSONA_PATTERNS, (2) add its credentials env (e.g.
  // LINKEDIN_<PERSONA>_EMAIL / X_AUTH_TOKEN_<PERSONA>), (3) list its slug
  // here (or in ORGANIC_GUARDRAIL_PERSONAS). The scheduler will pick it up
  // through the MANAGED_PERSONAS export.
  managedPersonas: csv('ORGANIC_MANAGED_PERSONAS', ['hanna', 'bob']),

  // --- Storage ----------------------------------------------------------
  ledgerPath: process.env.ORGANIC_LEDGER_PATH || '/app/cookies/organic-ledger.json',
};

/**
 * The set of personas the engine should actively manage (schedule warmups +
 * enforce the publish guardrail). Derived from the env CSV; always includes
 * the built-in synthetic personas so existing behaviour is preserved. This is
 * the single source the scheduler's MANAGED_ACCOUNTS consults, so adding a
 * persona is a config change, not a code change.
 */
export function managedPersonaSet() {
  const builtIn = ['hanna', 'bob'];
  const extra = ORGANIC_CONFIG.managedPersonas.filter((p) => !builtIn.includes(p));
  return [...builtIn, ...extra];
}

/** Warmup is allowed right now (respects quiet hours in local tz). */
export function isWithinQuietHours(now = new Date()) {
  const { timezone, quietHourStart, quietHourEnd } = ORGANIC_CONFIG;
  // en-US + hourCycle h23 yields a plain 0–23 number string (de-DE would
  // produce "2 Uhr", which Number() cannot parse).
  const hour = Number(
    new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: timezone }).format(now)
  );
  if (!Number.isFinite(hour)) return false;
  if (quietHourStart === quietHourEnd) return false;
  if (quietHourStart < quietHourEnd) {
    return hour >= quietHourStart && hour < quietHourEnd;
  }
  // Wraps midnight (e.g. 23 → 6).
  return hour >= quietHourStart || hour < quietHourEnd;
}

/** Randomized next warmup timestamp for an account. */
export function scheduleNextWarmup(from = new Date()) {
  const { minIntervalHours, maxIntervalHours } = ORGANIC_CONFIG;
  const lo = Math.min(minIntervalHours, maxIntervalHours);
  const hi = Math.max(minIntervalHours, maxIntervalHours);
  const hours = lo + Math.random() * (hi - lo);
  return new Date(from.getTime() + hours * 3_600_000);
}

/** Backoff after a failed warmup, as an absolute timestamp. */
export function scheduleFailureBackoff(from = new Date()) {
  const { failureBackoffMinH, failureBackoffMaxH } = ORGANIC_CONFIG;
  const lo = Math.min(failureBackoffMinH, failureBackoffMaxH);
  const hi = Math.max(failureBackoffMinH, failureBackoffMaxH);
  const hours = lo + Math.random() * (hi - lo);
  return new Date(from.getTime() + hours * 3_600_000);
}
