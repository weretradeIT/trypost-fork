/**
 * Organic Activity Engine — activity ledger.
 *
 * Persistent proof-of-life store. Every verified scroll session, reaction,
 * login and failure is recorded here with a timestamp; the publish guardrail
 * reads it to decide whether an account has recently "behaved like a human".
 *
 * Storage: single JSON file (default /app/cookies/organic-ledger.json — the
 * cookies dir is the one bind-mounted path that survives redeploys), written
 * atomically (tmp file + rename) with an in-process write queue.
 */

import fs from 'fs';
import path from 'path';
import { ORGANIC_CONFIG } from './config.js';

const MAX_EVENTS_PER_ACCOUNT = 200;

export class OrganicLedger {
  constructor(filePath = ORGANIC_CONFIG.ledgerPath) {
    this.filePath = filePath;
    this.state = { accounts: {} };
    this.writeChain = Promise.resolve();
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        if (parsed && typeof parsed === 'object' && parsed.accounts) {
          this.state = parsed;
        }
      }
    } catch (err) {
      console.warn(`[OrganicLedger] Failed to load ledger (${err.message}); starting fresh.`);
      this.state = { accounts: {} };
    }
  }

  account(accountKey) {
    if (!this.state.accounts[accountKey]) {
      this.state.accounts[accountKey] = {
        warmups: [], // { at, scrolls, reactions, ok, error? }
        logins: [], // { at, result }
        lastWarmupAt: null,
        nextWarmupAt: null,
        consecutiveFailures: 0,
        guardVerdicts: [], // { at, allowed, reason } — capped
      };
    }
    return this.state.accounts[accountKey];
  }

  appendEvent(listName, accountKey, event, cap = MAX_EVENTS_PER_ACCOUNT) {
    const acc = this.account(accountKey);
    acc[listName] = Array.isArray(acc[listName]) ? acc[listName] : [];
    acc[listName].push({ ...event, at: new Date().toISOString() });
    if (acc[listName].length > cap) acc[listName] = acc[listName].slice(-cap);
  }

  recordWarmup(accountKey, { ok, scrolls = 0, reactions = 0, error = null }) {
    const acc = this.account(accountKey);
    const at = new Date();
    this.appendEvent('warmups', accountKey, { ok, scrolls, reactions, error }, 100);
    acc.lastWarmupAt = at.toISOString();
    if (ok) {
      acc.consecutiveFailures = 0;
    } else {
      acc.consecutiveFailures = (acc.consecutiveFailures || 0) + 1;
    }
    this.persist();
  }

  recordLogin(accountKey, { ok, reason = null }) {
    this.appendEvent('logins', accountKey, { ok, reason }, 50);
    this.persist();
  }

  loginsToday(accountKey) {
    const acc = this.account(accountKey);
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    return (acc.logins || []).filter((l) => new Date(l.at) >= startOfDay).length;
  }

  recordGuardVerdict(accountKey, { allowed, reason }) {
    this.appendEvent('guardVerdicts', accountKey, { allowed, reason }, 60);
    // Ledger write is coalesced with the next one; still persist for freshness.
    this.persist();
  }

  /**
   * Most recent successful scroll session at most `maxAgeHours` old.
   */
  lastScrollWithin(accountKey, maxAgeHours) {
    const acc = this.account(accountKey);
    const cutoff = Date.now() - maxAgeHours * 3_600_000;
    for (let i = (acc.warmups || []).length - 1; i >= 0; i--) {
      const w = acc.warmups[i];
      if (w.ok && w.scrolls > 0) {
        const t = new Date(w.at).getTime();
        if (t >= cutoff) return w;
        return null; // newest successful scroll session is older than cutoff
      }
    }
    return null;
  }

  /**
   * Most recent verified reaction at most `maxAgeHours` old.
   */
  lastReactionWithin(accountKey, maxAgeHours) {
    const acc = this.account(accountKey);
    const cutoff = Date.now() - maxAgeHours * 3_600_000;
    for (let i = (acc.warmups || []).length - 1; i >= 0; i--) {
      const w = acc.warmups[i];
      if (w.ok && w.reactions > 0) {
        const t = new Date(w.at).getTime();
        if (t >= cutoff) return w;
        return null;
      }
    }
    return null;
  }

  reactionsToday(accountKey) {
    const acc = this.account(accountKey);
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    return (acc.warmups || [])
      .filter((w) => new Date(w.at) >= startOfDay)
      .reduce((sum, w) => sum + (w.reactions || 0), 0);
  }

  setNextWarmup(accountKey, nextAt) {
    const acc = this.account(accountKey);
    acc.nextWarmupAt = nextAt ? new Date(nextAt).toISOString() : null;
    this.persist();
  }

  status(accountKey) {
    const acc = this.account(accountKey);
    const lastOk = [...(acc.warmups || [])].reverse().find((w) => w.ok) || null;
    const lastReaction = [...(acc.warmups || [])].reverse().find((w) => w.ok && w.reactions > 0) || null;
    return {
      accountKey,
      lastWarmupAt: acc.lastWarmupAt,
      nextWarmupAt: acc.nextWarmupAt,
      consecutiveFailures: acc.consecutiveFailures || 0,
      lastScrollSession: lastOk ? lastOk.at : null,
      lastReactionAt: lastReaction ? lastReaction.at : null,
      reactionsToday: this.reactionsToday(accountKey),
      loginsToday: this.loginsToday(accountKey),
      guard: guardStatus(accountKey, this),
    };
  }

  /** Snapshot for /health and status endpoints. */
  snapshot() {
    const out = {};
    for (const key of Object.keys(this.state.accounts)) {
      out[key] = this.status(key);
    }
    return out;
  }

  persist() {
    // Serialize writes through a promise chain; drop errors but keep order.
    this.writeChain = this.writeChain
      .then(() => this.#writeNow())
      .catch((err) => console.warn(`[OrganicLedger] persist failed: ${err.message}`));
    return this.writeChain;
  }

  #writeNow() {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
  }
}

/**
 * Guard evaluation for one account (pure read of the ledger).
 * Exported separately so the guardrail module and status use one truth.
 */
export function guardStatus(accountKey, ledger) {
  if (!ORGANIC_CONFIG.guardrailEnabled) {
    return { required: false, allowed: true, reason: 'guardrail disabled' };
  }
  const scroll = ledger.lastScrollWithin(accountKey, ORGANIC_CONFIG.maxScrollAgeHours);
  if (!scroll) {
    return {
      required: true,
      allowed: false,
      reason: `No organic scroll session within ${ORGANIC_CONFIG.maxScrollAgeHours}h`,
    };
  }
  if (ORGANIC_CONFIG.requireReaction) {
    const reaction = ledger.lastReactionWithin(accountKey, ORGANIC_CONFIG.maxReactionAgeHours);
    if (!reaction) {
      // Selector drift happens (platforms redesign); if the account has had
      // ≥3 successful organic scroll sessions recently but reactions never
      // verified, degrade to scroll-only instead of freezing publishing.
      const recentSessions = (ledger.account(accountKey).warmups || []).filter(
        (w) => w.ok && w.scrolls > 0 && Date.now() - new Date(w.at).getTime() < ORGANIC_CONFIG.maxScrollAgeHours * 3_600_000
      ).length;
      if (recentSessions >= 3) {
        return {
          required: true,
          allowed: true,
          reason: `Scroll warm (${recentSessions} sessions); reaction verification degraded (selector drift)`,
        };
      }
      return {
        required: true,
        allowed: false,
        reason: `No verified reaction within ${ORGANIC_CONFIG.maxReactionAgeHours}h`,
      };
    }
  }
  return {
    required: true,
    allowed: true,
    reason: `Scroll ${scroll.scrolls} steps at ${scroll.at}`,
  };
}

// Single process-wide instance.
export const organicLedger = new OrganicLedger();
