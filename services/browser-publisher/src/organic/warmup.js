/**
 * Organic Activity Engine — warmup runner.
 *
 * Thin delegator: the actual engine selection (chromium vs camofox) and the
 * scroll/react/ledger logic now live in engine.js (runWarmupOnEngine). This
 * module keeps the stable `runWarmup(account, ledger)` signature the scheduler
 * and /warmup endpoint import, so switching engines is a pure env change
 * (ORGANIC_ENGINE) with no call-site edits.
 */

import { runWarmupOnEngine, activeEngine } from './engine.js';

/**
 * Run one organic warmup session for account (e.g. { platform: 'linkedin',
 * persona: 'bob' }). Delegates to the active engine.
 * Returns { ok, scrolls, reactions, error, engine }.
 */
export async function runWarmup(account, ledger) {
  return runWarmupOnEngine(account, ledger);
}

/** Which engine warmups currently run on (for status endpoints). */
export { activeEngine };
