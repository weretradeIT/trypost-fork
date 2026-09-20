/**
 * Organic Activity Engine — warmup scheduler.
 *
 * Keeps every managed account (hanna/bob on linkedin/x) in a "warm" state:
 *  - Each account gets one organic session every 3–7h (randomized),
 *    never during quiet hours (23:00–06:00 Europe/Berlin).
 *  - Failures back off exponentially-ish (1–3h) and are capped.
 *  - Password re-logins are capped at 1/day per account.
 *  - Random jitter on the tick check so sessions don't align to a grid.
 *
 * The scheduler also exposes warmStatus() for /health and agent queries, and
 * warmupNow(accountKey) for manual triggers.
 */

import { ORGANIC_CONFIG, isWithinQuietHours, scheduleNextWarmup, scheduleFailureBackoff } from './config.js';
import { organicLedger } from './ledger.js';
import { runWarmup } from './warmup.js';
import { resolveAccount } from './accounts.js';

const MANAGED_ACCOUNTS = [
  { platform: 'linkedin', username: 'hanna-wt-463566426' },
  { platform: 'linkedin', username: 'bob-wt-ab1559426' },
  { platform: 'x', username: 'weretradeHanna' },
  { platform: 'x', username: 'bob_w1408' },
];

let tickTimer = null;
let running = false;
// In-flight warmups per account key. A manual /warmup must never stack a
// second browser on an account that a tick (or another manual trigger) is
// already warming: concurrent sessions on one cookie jar cause fingerprint
// divergence and waste the daily login budget.
const inFlight = new Map(); // accountKey → true

export function activeWarmupKeys() {
  return [...inFlight.keys()];
}

/** Atomically claim an account for warmup; false if already in flight. */
function claim(accountKey) {
  if (inFlight.has(accountKey)) return false;
  inFlight.set(accountKey, true);
  return true;
}
function release(accountKey) {
  inFlight.delete(accountKey);
}

function managedAccounts() {
  return MANAGED_ACCOUNTS.map(({ platform, username }) => resolveAccount(platform, username)).filter(
    (a) => a && a.managed
  );
}

/**
 * Initialize the ledger entries and next-run times for all managed accounts.
 * Safe to call multiple times.
 */
export function initScheduler() {
  if (!ORGANIC_CONFIG.enabled) {
    console.log('[OrganicScheduler] Organic warmup DISABLED (ORGANIC_WARMUP_ENABLED=0).');
    return;
  }

  for (const account of managedAccounts()) {
    const acc = organicLedger.account(account.accountKey);
    if (!acc.nextWarmupAt) {
      organicLedger.setNextWarmup(account.accountKey, scheduleNextWarmup());
    }
    console.log(
      `[OrganicScheduler] Managing ${account.accountKey}: next warmup at ${organicLedger.account(account.accountKey).nextWarmupAt}`
    );
  }

  // Fire the first tick soon after boot (jittered 1–3 min).
  const firstDelayMs = (60 + Math.random() * 120) * 1000;
  tickTimer = setTimeout(() => tickLoop(), firstDelayMs);
  console.log(
    `[OrganicScheduler] Started. tick=${ORGANIC_CONFIG.tickMinutes}min first-check in ${Math.round(firstDelayMs / 1000)}s`
  );
}

async function tickLoop() {
  if (running) {
    // Previous tick still busy — skip this round cleanly.
    scheduleNextTick();
    return;
  }
  running = true;
  try {
    await runDueWarmups();
  } catch (err) {
    console.error(`[OrganicScheduler] Tick failed: ${err.message}`);
  } finally {
    running = false;
    scheduleNextTick();
  }
}

function scheduleNextTick() {
  if (tickTimer) clearTimeout(tickTimer);
  const jitterMs = Math.random() * 30_000;
  tickTimer = setTimeout(() => tickLoop(), ORGANIC_CONFIG.tickMinutes * 60_000 + jitterMs);
}

async function runDueWarmups() {
  if (isWithinQuietHours()) {
    console.log('[OrganicScheduler] Quiet hours — no warmup sessions.');
    // Push any due warmups to after quiet hours.
    for (const account of managedAccounts()) {
      const acc = organicLedger.account(account.accountKey);
      if (new Date(acc.nextWarmupAt) <= new Date()) {
        organicLedger.setNextWarmup(
          account.accountKey,
          new Date(Date.now() + 45 * 60_000 * (1 + Math.random()))
        );
      }
    }
    return;
  }

  for (const account of managedAccounts()) {
    const acc = organicLedger.account(account.accountKey);
    const due = new Date(acc.nextWarmupAt) <= new Date();
    if (!due) continue;

    if (!claim(account.accountKey)) {
      console.log(`[OrganicScheduler] ${account.accountKey} already warming (manual trigger); skipping tick.`);
      continue;
    }
    console.log(`[OrganicScheduler] Warmup due for ${account.accountKey}.`);
    let result;
    try {
      result = await runWarmup(account, organicLedger);
    } finally {
      release(account.accountKey);
    }

    const next = result.ok
      ? scheduleNextWarmup()
      : scheduleFailureBackoff();
    organicLedger.setNextWarmup(account.accountKey, next);
    console.log(`[OrganicScheduler] Next warmup for ${account.accountKey}: ${next.toISOString()}`);
  }
}

/**
 * Manually trigger a warmup (used by /warmup endpoint and Slack commands).
 * respects the daily login budget indirectly via ledger; runs immediately
 * regardless of schedule.
 */
export async function warmupNow(platform, username) {
  const account = resolveAccount(platform, username);
  if (!account || !account.managed) {
    return { ok: false, error: `No managed account for ${platform}/${username}` };
  }
  if (!claim(account.accountKey)) {
    return {
      ok: false,
      error: `Warmup for ${account.accountKey} is already in progress — retry in a minute.`,
      busy: true,
    };
  }
  let result;
  try {
    result = await runWarmup(account, organicLedger);
  } finally {
    release(account.accountKey);
  }
  organicLedger.setNextWarmup(
    account.accountKey,
    result.ok ? scheduleNextWarmup() : scheduleFailureBackoff()
  );
  return result;
}

/** Status snapshot for all managed accounts (for /health, agents). */
export function warmStatus() {
  const accounts = {};
  for (const account of managedAccounts()) {
    accounts[account.accountKey] = organicLedger.status(account.accountKey);
  }
  return {
    enabled: ORGANIC_CONFIG.enabled,
    guardrail: {
      enabled: ORGANIC_CONFIG.guardrailEnabled,
      maxScrollAgeHours: ORGANIC_CONFIG.maxScrollAgeHours,
      requireReaction: ORGANIC_CONFIG.requireReaction,
      maxReactionAgeHours: ORGANIC_CONFIG.maxReactionAgeHours,
      enforcedPersonas: ORGANIC_CONFIG.enforcedPersonas,
    },
    accounts,
  };
}
