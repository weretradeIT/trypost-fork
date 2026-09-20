/**
 * Organic Activity Engine — egress IP guardrail (HARD, fail-closed).
 *
 * Every browser session (warmup AND publish) validates the egress IP before
 * touching LinkedIn/X. lair404 sits on a Hetzner datacenter IP — exactly the
 * ASN class platforms treat as automation. A session from a non-residential,
 * non-allowlisted IP must NEVER reach the platform.
 *
 * Policy (in order):
 *  1. If ORGANIC_EGRESS_ALLOWLIST is set: IP must match an entry (exact or
 *     CIDR). Allowlist wins over everything — it is an explicit operator trust.
 *  2. If allowlist is empty: the IP's org (ASN description) must NOT contain
 *     a known datacenter keyword (hetzner, ovh, …) — heuristic residential.
 *  3. If the check cannot run (lookup failure): DENY (fail-closed) while
 *     enforcement is on.
 *
 * When ORGANIC_BROWSER_PROXY is set, the check runs THROUGH that proxy in a
 * throwaway browser context, so we validate the egress the sessions will
 * actually use — not the host's default route.
 */

import { ORGANIC_CONFIG } from './config.js';

export class EgressPolicyError extends Error {
  constructor(reason, details = {}) {
    super(`EGRESS_POLICY: ${reason}`);
    this.name = 'EgressPolicyError';
    this.details = details;
  }
}

/** IPv4 exact/CIDR match. */
export function ipv4InCidr(ip, cidr) {
  const c = cidr.includes('/') ? cidr : `${cidr}/32`;
  const [base, bitsStr] = c.split('/');
  const bits = parseInt(bitsStr, 10);
  if (![ip, base].every((s) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s)) || !(bits >= 0 && bits <= 32)) {
    return false;
  }
  const toInt = (s) => s.split('.').reduce((acc, o) => (acc << 8) + parseInt(o, 10), 0) >>> 0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((toInt(ip) & mask) >>> 0) === ((toInt(base) & mask) >>> 0);
}

/**
 * PURE policy evaluation — unit-testable without network.
 */
export function evaluateEgressPolicy({ ip, org = '' }, { allowlist = [], dcKeywords = ORGANIC_CONFIG.egressDcKeywords } = {}) {
  if (!ip) return { ok: false, reason: 'no egress IP determined', scope: 'lookup' };
  const entries = Array.isArray(allowlist) ? allowlist.filter(Boolean) : [];
  if (entries.length > 0) {
    const matched = entries.find((e) => ipv4InCidr(ip, e));
    if (matched) {
      return { ok: true, reason: `IP ${ip} is allowlisted (${matched})`, scope: 'allowlist' };
    }
    return {
      ok: false,
      reason: `IP ${ip} is NOT in the residential allowlist [${entries.join(', ')}]`,
      scope: 'allowlist',
    };
  }
  const orgLower = String(org).toLowerCase();
  const hit = dcKeywords.find((k) => k && orgLower.includes(k));
  if (hit) {
    return { ok: false, reason: `Egress ${ip} belongs to datacenter org "${org}" (keyword: ${hit})`, scope: 'asn' };
  }
  return { ok: true, reason: `Egress ${ip} org "${org}" looks residential`, scope: 'asn' };
}

// ---- Live check with cache -------------------------------------------------

let cached = null; // { ok, ip, org, reason, checkedAt }

async function lookupEgress() {
  const { browserProxy } = ORGANIC_CONFIG;
  if (browserProxy) {
    // Measure through the SAME proxy the sessions use.
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
      proxy: { server: browserProxy },
    });
    try {
      const page = await (await browser.newContext()).newPage();
      const res = await page.goto('https://ipinfo.io/json', { timeout: 15000, waitUntil: 'domcontentloaded' });
      return await res.json();
    } finally {
      await browser.close().catch(() => {});
    }
  }
  // Direct route: plain node fetch is enough (no proxy → node fetch uses the
  // same default egress as the browser).
  const res = await fetch('https://ipinfo.io/json', { signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`ipinfo HTTP ${res.status}`);
  return res.json();
}

/**
 * Cached egress verdict. force=true bypasses the cache (manual re-check).
 */
export async function checkEgress({ force = false } = {}) {
  const now = Date.now();
  const ttlMs = ORGANIC_CONFIG.egressCacheMinutes * 60_000;
  if (!force && cached && now - cached.checkedAt < ttlMs) {
    return cached;
  }

  let verdict;
  try {
    const info = await lookupEgress();
    verdict = evaluateEgressPolicy(
      { ip: info.ip, org: info.org },
      { allowlist: ORGANIC_CONFIG.egressAllowlist, dcKeywords: ORGANIC_CONFIG.egressDcKeywords }
    );
    cached = { ...verdict, ip: info.ip, org: info.org, checkedAt: now };
  } catch (err) {
    // Fail-closed while enforcement is on.
    cached = {
      ok: !ORGANIC_CONFIG.egressEnforce,
      reason: `Egress lookup failed (${err.message.split('\n')[0]}) — ${ORGANIC_CONFIG.egressEnforce ? 'DENIED (fail-closed)' : 'allowed (enforcement off)'}`,
      ip: null,
      org: null,
      checkedAt: now,
      error: err.message.split('\n')[0],
    };
  }
  console.log(`[EgressGuard] ${cached.ok ? 'OK' : 'BLOCK'}: ${cached.reason}`);
  return cached;
}

/**
 * HARD guardrail for every browser session. Throws EgressPolicyError when the
 * current egress is not acceptable. No exception while disabled (explicit
 * operator opt-out for staging).
 */
export async function assertEgressAllowed() {
  if (!ORGANIC_CONFIG.egressEnforce) {
    return { ok: true, reason: 'egress enforcement disabled' };
  }
  const v = await checkEgress();
  if (!v.ok) {
    throw new EgressPolicyError(v.reason, { ip: v.ip, org: v.org });
  }
  return v;
}

/** Last known verdict without re-checking (for /organic-status). */
export function lastEgressVerdict() {
  return cached ? { ...cached } : null;
}
