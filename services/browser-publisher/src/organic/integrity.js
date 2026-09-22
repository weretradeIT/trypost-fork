/**
 * Organic Activity Engine — live-action integrity gate.
 *
 * The whole point: BEFORE any live action (warmup OR publish) touches a real
 * account, verify that the ACTIVE measurement/anti-detect stack is actually
 * on and correctly configured. If a measurement is missing (residential
 * egress down, client-hints not aligned, fingerprint patch absent, WebRTC
 * unlocked), the session is REFUSED — fail-closed — so we never run "in the
 * trap" of a half-hardened session that a platform fingerprinter would flag
 * instantly.
 *
 * This module is PURE (no browser, no network) so it is unit-tested offline.
 * It takes a `measurements` descriptor (what the caller just configured for
 * THIS session) and returns a verdict. The caller (browser.js — the single
 * choke point every session flows through) supplies the descriptor and throws
 * on failure. Because it lives in the choke point, it automatically covers
 * hanna/bob AND any future persona with zero per-call-site changes.
 *
 * Two layers:
 *   - `checkLiveActionIntegrity(measurements)` — pure verdict builder.
 *   - `assertLiveActionIntegrity(measurements)` — throws IntegrityError.
 */

import { ORGANIC_CONFIG } from './config.js';

/** Marker constants the fingerprint init script reliably contains. */
const FINGERPRINT_MARKERS = [
  "Object.defineProperty(navigator, 'platform'",
  'userAgentData',
  "rtt",
];

/**
 * Build the measurement descriptor for a session about to start.
 *
 * This is the "what is actually configured for THIS session" snapshot the
 * gate checks. Kept here (not in browser.js) so it is testable in isolation
 * and is the single definition of "which measurements are active".
 *
 * @param {object} opts
 * @param {string} opts.platform          logical key ('linkedin' | 'x' | …)
 * @param {object} opts.egressVerdict     lastEgressVerdict() result (may be null)
 * @param {string} opts.browserProxy      the proxy the context will use ('' if none)
 * @param {object} opts.clientHints       clientHintsFor(platform) result
 * @param {string} opts.userAgent         userAgentFor(platform) result
 * @param {string} opts.fingerprintScript fingerprintInitScript(ua, platform) result
 * @param {string[]} opts.launchArgs      the browser launch args in force
 */
export function buildMeasurements(opts) {
  const {
    platform = 'x',
    egressVerdict = null,
    browserProxy = '',
    clientHints = {},
    userAgent = '',
    fingerprintScript = '',
    launchArgs = [],
  } = opts || {};

  const egress = egressVerdict || {};
  const secChUa = clientHints['sec-ch-ua'] || '';
  const hints = {
    secChUaPresent: secChUa.length > 0,
    // The single biggest headless tell: "HeadlessChrome" in the brand list.
    headlessChromeLeak: /HeadlessChrome/i.test(secChUa),
    alignedChromeBrand: /Google Chrome/i.test(secChUa) && /Chromium/i.test(secChUa),
    mobileFlag: clientHints['sec-ch-ua-mobile'],
  };

  // UA / hint / fingerprint version cross-check (the "no cross-signal drift"
  // property). Parse the Chrome major out of the UA and out of sec-ch-ua and
  // require they agree.
  const uaMajor = (/Chrome\/(\d+)\./.exec(userAgent) || [])[1] || null;
  const hintMajor = (/Google Chrome";v="(\d+)/.exec(secChUa) || [])[1] || null;
  const versionAligned = uaMajor !== null && uaMajor === hintMajor;

  const fingerprintPresent = FINGERPRINT_MARKERS.every((m) => fingerprintScript.includes(m));

  const webrtcArgs = [
    '--webrtc-ip-handling-policy=disable_non_proxied',
    '--force-webrtc-ip-handling-policy=disable_non_proxied',
  ];
  const webrtcLocked = webrtcArgs.every((a) => (launchArgs || []).includes(a));

  const proxyConfigured = typeof browserProxy === 'string' && browserProxy.trim().length > 0;
  const egressOk = egress.ok === true;
  // A residential verdict is the one we actually want for live actions: ok AND
  // not flagged as a datacenter org. evaluateEgressPolicy already encodes that
  // in .ok, so egressOk === "residential allowed".
  const residential = egressOk && egress.scope !== 'dc-keyword' && !/datacenter/i.test(egress.reason || '');

  return {
    platform,
    egress: {
      configured: egress.ip !== undefined && egress.ip !== null && egress.ip !== '',
      ok: egressOk,
      residential,
      scope: egress.scope || null,
      ip: egress.ip || null,
      org: egress.org || null,
      country: egress.country || null,
      reason: egress.reason || null,
      stale: Boolean(egress.stale) || Date.now() - (egress.checkedAt || 0) > 24 * 3_600_000,
    },
    proxy: {
      configured: proxyConfigured,
      // Never leak the proxy URL/credentials into the measurement report.
      hasCredential: /:\/\/[^@/]+@/.test(browserProxy),
    },
    hints,
    fingerprint: {
      present: fingerprintPresent,
      versionAligned,
      uaMajor: uaMajor ? Number(uaMajor) : null,
      hintMajor: hintMajor ? Number(hintMajor) : null,
    },
    webrtc: { locked: webrtcLocked },
  };
}

/**
 * Pure verdict: is this measurement stack good enough for a LIVE action?
 * @returns {{ok: boolean, blockers: string[], warnings: string[]}}
 */
export function checkLiveActionIntegrity(m) {
  const blockers = [];
  const warnings = [];
  if (!m) return { ok: false, blockers: ['no measurement descriptor'], warnings };

  const cfg = ORGANIC_CONFIG;

  // 1. Residential egress — the hard one. A live action must leave from a
  //    residential IP; a datacenter/unknown egress is a blocker.
  if (cfg.liveActionRequireResidential) {
    if (!m.egress.configured) {
      blockers.push('egress measurement not active (no egress verdict — cannot confirm residential IP)');
    } else if (!m.egress.ok) {
      blockers.push(`egress egress not allowed: ${m.egress.reason || 'unknown'}`);
    } else if (!m.egress.residential) {
      blockers.push('egress is allowed but not confirmed residential');
    } else if (m.egress.stale) {
      blockers.push('egress verdict is stale (>24h) — re-check before a live action');
    }
  }

  // 2. Proxy must be configured when residential is required. No proxy → the
  //    session would egress from the host (datacenter) IP.
  if (cfg.liveActionRequireResidential && !m.proxy.configured) {
    blockers.push('no residential proxy configured (ORGANIC_BROWSER_PROXY empty)');
  }

  // 3. Aligned client-hints — no HeadlessChrome brand, correct Chrome brand,
  //    desktop flag.
  if (cfg.liveActionRequireAlignedHints) {
    if (!m.hints.secChUaPresent) blockers.push('client-hints missing (no sec-ch-ua)');
    if (m.hints.headlessChromeLeak) blockers.push('HeadlessChrome brand leaked in sec-ch-ua');
    if (m.hints.secChUaPresent && !m.hints.alignedChromeBrand) {
      blockers.push('sec-ch-ua does not carry the aligned Chrome/Chromium brands');
    }
    if (m.hints.mobileFlag && m.hints.mobileFlag !== '?0') {
      warnings.push('sec-ch-ua-mobile is not ?0 (desktop persona expected)');
    }
  }

  // 4. Fingerprint patch present + internally coherent (version alignment).
  if (cfg.liveActionRequireFingerprint) {
    if (!m.fingerprint.present) blockers.push('in-page fingerprint patch not present');
    if (m.fingerprint.present && !m.fingerprint.versionAligned) {
      blockers.push(
        `fingerprint version drift: UA major ${m.fingerprint.uaMajor} vs hint major ${m.fingerprint.hintMajor}`
      );
    }
  }

  // 5. WebRTC locked to the proxy (no host-IP leak).
  if (cfg.liveActionRequireWebrtc) {
    if (!m.webrtc.locked) blockers.push('WebRTC not locked to proxy (host-IP leak possible)');
  }

  // Non-blocking warnings (recorded, not refused): proxy credential present
  // (fine, expected for authenticated residential), etc.
  if (m.proxy.configured && !m.proxy.hasCredential) {
    warnings.push('proxy configured without credentials (verify the residential provider expects none)');
  }

  return { ok: blockers.length === 0, blockers, warnings };
}

/** Thrown when a live action is refused by the integrity gate. */
export class LiveActionIntegrityError extends Error {
  constructor(verdict, measurements) {
    super(`Live-action integrity gate BLOCKED session: ${verdict.blockers.join('; ')}`);
    this.name = 'LiveActionIntegrityError';
    this.category = 'integrity_gate';
    this.verdict = verdict;
    this.measurements = measurements;
  }
}

/**
 * Build the descriptor and assert it. Throws LiveActionIntegrityError when
 * the gate is enabled and any blocker is present. No-op (returns the
 * descriptor) when the gate is disabled.
 *
 * @returns {object} the measurement descriptor (always returned, even on pass).
 */
export function assertLiveActionIntegrity(opts) {
  const m = buildMeasurements(opts);
  if (!ORGANIC_CONFIG.liveActionIntegrityEnabled) {
    return m;
  }
  const verdict = checkLiveActionIntegrity(m);
  if (!verdict.ok) {
    throw new LiveActionIntegrityError(verdict, m);
  }
  if (verdict.warnings.length) {
    console.warn(`[Integrity] live-action warnings: ${verdict.warnings.join('; ')}`);
  }
  return m;
}
