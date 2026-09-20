/**
 * Organic Activity Engine — account resolution.
 *
 * Maps an incoming publish/warmup request (platform + username, e.g.
 * "linkedin" + "bob-wt-ab1559426" or "x" + "weretradeHanna") onto a canonical
 * account key ("linkedin:hanna", "x:bob", …) and decides whether the account
 * belongs to a synthetic persona that organic warmup applies to.
 */

import { ORGANIC_CONFIG } from './config.js';

export const PERSONA_PATTERNS = [
  { persona: 'hanna', needles: ['hanna', 'weretradehanna', 'hanna-wt', 'hanna.t'] },
  { persona: 'bob', needles: ['bob', 'weretradebob', 'bob-wt', 'bob_w', 'weber'] },
];

export function detectPersona(username) {
  const u = String(username || '').toLowerCase();
  for (const { persona, needles } of PERSONA_PATTERNS) {
    if (needles.some((n) => u.includes(n))) return persona;
  }
  return null;
}

/** Normalize a platform value to the account namespace used by the engine. */
export function normalizePlatform(platform) {
  const p = String(platform || '').toLowerCase();
  if (p === 'linkedin' || p === 'linkedin-page') return 'linkedin';
  if (p === 'x' || p === 'twitter') return 'x';
  return p;
}

/**
 * Resolve a request to an account descriptor.
 *
 * Returns null for unknown platforms (guardrail does not apply, warmup not
 * possible) — callers must treat that as "not managed by the engine".
 */
export function resolveAccount(platform, username) {
  const normPlatform = normalizePlatform(platform);
  if (normPlatform !== 'linkedin' && normPlatform !== 'x') return null;

  const persona = detectPersona(username);
  // Corporate / human-owned accounts: managed = false (no warmup, no guard).
  const managed = persona !== null && ORGANIC_CONFIG.enforcedPersonas.includes(persona);

  return {
    platform: normPlatform,
    persona, // 'hanna' | 'bob' | null (corporate)
    accountKey: persona ? `${normPlatform}:${persona}` : `${normPlatform}:corporate:${String(username).toLowerCase()}`,
    managed,
  };
}

/** Cookie file used by the publishers for this account. */
export function cookieFileFor(account) {
  return `/app/cookies/${account.persona || 'corporate'}.json`;
}
