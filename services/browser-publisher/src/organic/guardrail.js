/**
 * Organic Activity Engine — publish guardrail.
 *
 * BEFORE any publish for a synthetic persona (Hanna, Bob), verify the account
 * has recent organic behavior: a scroll session within maxScrollAgeHours and
 * (optionally) a verified reaction within maxReactionAgeHours.
 *
 * This closes the "posts but never browses" gap that got Bob's LinkedIn
 * account flagged as a synthetic persona by LinkedIn's Graph-ML filters
 * (public profile 404, silent checkpoint — 2026-09-18 forensic report).
 *
 * Blocked publishes return HTTP 425 with category 'content_policy' and a
 * retry_after_minutes hint. Unmanaged (corporate/human) accounts pass.
 */

import { resolveAccount } from './accounts.js';
import { organicLedger, guardStatus } from './ledger.js';
import { ORGANIC_CONFIG } from './config.js';

/**
 * Evaluate the guard for a publish request.
 * Returns { allowed: true } or { allowed: false, reason, retryAfterMinutes }.
 */
export function assertOrganicBeforePublish(platform, username) {
  const account = resolveAccount(platform, username);

  // Unknown platform / corporate account: not our synthetic-persona problem.
  if (!account || !account.managed) {
    return { allowed: true, account, reason: 'unmanaged account (corporate or unknown platform)' };
  }
  if (!ORGANIC_CONFIG.guardrailEnabled) {
    return { allowed: true, account, reason: 'guardrail disabled' };
  }

  const verdict = guardStatus(account.accountKey, organicLedger);

  organicLedger.recordGuardVerdict(account.accountKey, {
    allowed: verdict.allowed,
    reason: verdict.reason,
  });

  if (verdict.allowed) {
    return { allowed: true, account, reason: verdict.reason };
  }

  // How long until the account is warm again? Be conservative: if the next
  // scheduled warmup is far out, hint at the guard window instead.
  const acc = organicLedger.account(account.accountKey);
  let retryAfterMinutes = ORGANIC_CONFIG.maxScrollAgeHours * 60;
  if (acc.nextWarmupAt) {
    const mins = Math.ceil((new Date(acc.nextWarmupAt).getTime() - Date.now()) / 60_000);
    if (mins > 0) retryAfterMinutes = Math.min(retryAfterMinutes, mins + 5);
  }

  return {
    allowed: false,
    account,
    reason: `ORGANIC_ACTIVITY_REQUIRED: ${verdict.reason}. Der Post wurde blockiert, damit LinkedIn/X das Konto nicht als Bot einstuft. Ein organischer Warmup-Scroll (und eine Reaktion) läuft automatisch; danach erneut veröffentlichen.`,
    retryAfterMinutes,
  };
}

/** Compact guard status for one account (used by agents' /social-status). */
export function guardForAccount(platform, username) {
  const account = resolveAccount(platform, username);
  if (!account) return { managed: false };
  return {
    managed: account.managed,
    accountKey: account.accountKey,
    ...organicLedger.status(account.accountKey).guard,
  };
}
