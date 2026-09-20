/**
 * Offline unit test for the organic engine's pure logic:
 * account resolution, guard verdicts, ledger windows, quiet hours.
 * Run: node src/organic/selftest.js  (no browser, no network)
 */

import assert from 'node:assert/strict';
import { resolveAccount, normalizePlatform, detectPersona } from './accounts.js';
import { guardStatus, OrganicLedger } from './ledger.js';
import { isWithinQuietHours } from './config.js';
import { evaluateEgressPolicy, ipv4InCidr } from './egress.js';
import { activeEngine } from './engine.js';
import { camofoxUserIdFor } from './camofox-engine.js';
import { ORGANIC_CONFIG } from './config.js';
import { fingerprintInitScript } from './fingerprint.js';

let passed = 0;
let failed = 0;
const t = (name, fn) => {
  try {
    fn();
    passed++;
    console.log(`✓ PASS: ${name}`);
  } catch (err) {
    failed++;
    console.error(`❌ FAIL: ${name}: ${err.message}`);
  }
};

// ---- Account resolution ---------------------------------------------------
t('detectPersona: bob variants', () => {
  assert.equal(detectPersona('bob-wt-ab1559426'), 'bob');
  assert.equal(detectPersona('bob_w1408'), 'bob');
  assert.equal(detectPersona('weretradeBob'), 'bob');
});
t('detectPersona: hanna variants', () => {
  assert.equal(detectPersona('hanna-wt-463566426'), 'hanna');
  assert.equal(detectPersona('weretradeHanna'), 'hanna');
});
t('detectPersona: corporate → null', () => {
  assert.equal(detectPersona('weretradeit'), null);
  assert.equal(detectPersona('weretrade-admin'), null);
});
t('resolveAccount: linkedin bob is managed', () => {
  const a = resolveAccount('linkedin', 'bob-wt-ab1559426');
  assert.equal(a.managed, true);
  assert.equal(a.accountKey, 'linkedin:bob');
});
t('resolveAccount: linkedin-page normalizes to linkedin', () => {
  const a = resolveAccount('linkedin-page', 'hanna-wt-463566426');
  assert.equal(a.platform, 'linkedin');
  assert.equal(a.accountKey, 'linkedin:hanna');
});
t('resolveAccount: x hanna managed', () => {
  const a = resolveAccount('x', 'weretradeHanna');
  assert.equal(a.managed, true);
  assert.equal(a.accountKey, 'x:hanna');
});
t('resolveAccount: corporate unmanaged', () => {
  const a = resolveAccount('x', 'weretrade');
  assert.equal(a.managed, false);
  assert.ok(a.accountKey.includes('corporate'));
});
t('resolveAccount: unknown platform → null', () => {
  assert.equal(resolveAccount('facebook', 'bob'), null);
});
t('normalizePlatform: twitter → x', () => {
  assert.equal(normalizePlatform('twitter'), 'x');
});

// ---- Ledger + guard windows ------------------------------------------------
process.env.ORGANIC_LEDGER_PATH = '/tmp/organic-ledger-test-' + process.pid + '.json';

t('Ledger: fresh account is cold (guard denies)', () => {
  const l = new OrganicLedger(process.env.ORGANIC_LEDGER_PATH);
  const v = guardStatus('linkedin:bob', l);
  assert.equal(v.allowed, false);
  assert.match(v.reason, /No organic scroll session/);
});

t('Ledger: scroll without reaction → denied when reactions required', () => {
  const l = new OrganicLedger(process.env.ORGANIC_LEDGER_PATH);
  l.recordWarmup('x:hanna', { ok: true, scrolls: 4, reactions: 0 });
  const v = guardStatus('x:hanna', l);
  assert.equal(v.allowed, false);
  assert.match(v.reason, /No verified reaction/);
});

t('Ledger: recent scroll + reaction → allowed', () => {
  const l = new OrganicLedger(process.env.ORGANIC_LEDGER_PATH);
  l.recordWarmup('linkedin:hanna', { ok: true, scrolls: 4, reactions: 1 });
  const v = guardStatus('linkedin:hanna', l);
  assert.equal(v.allowed, true);
  assert.match(v.reason, /Scroll 4 steps/);
});

t('Ledger: stale scroll (30h old) → denied', () => {
  const l = new OrganicLedger(process.env.ORGANIC_LEDGER_PATH);
  // Inject a warmup event with an old timestamp directly.
  const acc = l.account('x:bob');
  acc.warmups.push({ at: new Date(Date.now() - 30 * 3_600_000).toISOString(), ok: true, scrolls: 5, reactions: 1 });
  const v = guardStatus('x:bob', l);
  assert.equal(v.allowed, false);
});

t('Ledger: reactionsToday counts across sessions', () => {
  const l = new OrganicLedger(process.env.ORGANIC_LEDGER_PATH);
  l.recordWarmup('x:hanna', { ok: true, scrolls: 2, reactions: 2 });
  l.recordWarmup('x:hanna', { ok: true, scrolls: 2, reactions: 1 });
  assert.equal(l.reactionsToday('x:hanna'), 3);
});

t('Ledger: loginsToday counts', () => {
  const l = new OrganicLedger(process.env.ORGANIC_LEDGER_PATH);
  l.recordLogin('linkedin:bob', { ok: true });
  assert.equal(l.loginsToday('linkedin:bob'), 1);
});

t('Ledger: failure streak tracked', () => {
  const l = new OrganicLedger(process.env.ORGANIC_LEDGER_PATH);
  l.recordWarmup('x:bob', { ok: false, error: 'x' });
  l.recordWarmup('x:bob', { ok: false, error: 'y' });
  assert.equal(l.account('x:bob').consecutiveFailures, 2);
  l.recordWarmup('x:bob', { ok: true, scrolls: 3, reactions: 0 });
  assert.equal(l.account('x:bob').consecutiveFailures, 0);
});

t('Guard: 3 scroll sessions without reaction → degraded allow', () => {
  const l = new OrganicLedger(process.env.ORGANIC_LEDGER_PATH);
  const key = 'x:drift-test';
  l.recordWarmup(key, { ok: true, scrolls: 3, reactions: 0 });
  l.recordWarmup(key, { ok: true, scrolls: 3, reactions: 0 });
  const v2 = guardStatus(key, l);
  assert.equal(v2.allowed, false, 'two sessions must still block');
  l.recordWarmup(key, { ok: true, scrolls: 3, reactions: 0 });
  const v3 = guardStatus(key, l);
  assert.equal(v3.allowed, true, 'three sessions must degrade-allow');
  assert.match(v3.reason, /selector drift/);
});

// ---- Quiet hours -------------------------------------------------------------
t('Quiet hours: 02:00 Berlin is quiet', () => {
  const at = new Date('2026-09-19T02:00:00+02:00');
  assert.equal(isWithinQuietHours(at), true);
});
t('Quiet hours: 14:00 Berlin is not quiet', () => {
  const at = new Date('2026-09-19T14:00:00+02:00');
  assert.equal(isWithinQuietHours(at), false);
});

// ---- Egress policy ----------------------------------------------------------
t('CIDR: exact IP match', () => {
  assert.equal(ipv4InCidr('1.2.3.4', '1.2.3.4'), true);
  assert.equal(ipv4InCidr('1.2.3.5', '1.2.3.4'), false);
});
t('CIDR: /24 subnet match', () => {
  assert.equal(ipv4InCidr('84.12.5.100', '84.12.5.0/24'), true);
  assert.equal(ipv4InCidr('84.12.6.100', '84.12.5.0/24'), false);
});
t('Egress: datacenter org blocked (Hetzner)', () => {
  const v = evaluateEgressPolicy({ ip: '178.63.56.179', org: 'AS24940 Hetzner Online GmbH' });
  assert.equal(v.ok, false);
  assert.match(v.reason, /datacenter/);
});
t('Egress: residential org allowed', () => {
  const v = evaluateEgressPolicy({ ip: '84.12.5.100', org: 'Deutsche Telekom AG' });
  assert.equal(v.ok, true);
});
t('Egress: allowlist wins over datacenter keyword', () => {
  const v = evaluateEgressPolicy(
    { ip: '178.63.56.179', org: 'AS24940 Hetzner Online GmbH' },
    { allowlist: ['178.63.56.0/24'] }
  );
  assert.equal(v.ok, true);
  assert.equal(v.scope, 'allowlist');
});
t('Egress: non-allowlisted IP denied even if residential', () => {
  const v = evaluateEgressPolicy(
    { ip: '84.12.5.100', org: 'Deutsche Telekom AG' },
    { allowlist: ['1.2.3.0/24'] }
  );
  assert.equal(v.ok, false);
  assert.equal(v.scope, 'allowlist');
});
t('Egress: missing IP → deny (fail-closed)', () => {
  const v = evaluateEgressPolicy({ ip: null, org: '' });
  assert.equal(v.ok, false);
});

// ---- Client-hints / header alignment --------------------------------------
import { clientHintsFor, userAgentFor } from './browser.js';

t('Client-hints: sec-ch-ua has no HeadlessChrome brand', () => {
  for (const p of ['linkedin', 'x']) {
    const h = clientHintsFor(p);
    assert.ok(!/HeadlessChrome/.test(h['sec-ch-ua']), `HeadlessChrome leaked for ${p}`);
    assert.match(h['sec-ch-ua'], /Google Chrome/);
    assert.match(h['sec-ch-ua'], /Chromium/);
  }
});
t('Client-hints: sec-ch-ua major matches UA major (no drift)', () => {
  for (const p of ['linkedin', 'x']) {
    const h = clientHintsFor(p);
    const ua = userAgentFor(p);
    const mUa = /Chrome\/(\d+)\./.exec(ua);
    const mHint = /Google Chrome";v="(\d+)/.exec(h['sec-ch-ua']);
    assert.ok(mUa && mHint, `could not parse major for ${p}`);
    assert.equal(mUa[1], mHint[1], `UA ${mUa[1]} vs hint ${mHint[1]} for ${p}`);
  }
});
t('Client-hints: platform matches platform identity', () => {
  assert.equal(clientHintsFor('linkedin')['sec-ch-ua-platform'], '"macOS"');
  assert.equal(clientHintsFor('x')['sec-ch-ua-platform'], '"Windows"');
  // unknown platform falls back to the Windows default
  assert.equal(clientHintsFor('nope')['sec-ch-ua-platform'], '"Windows"');
});
t('Client-hints: always desktop (mobile ?0)', () => {
  assert.equal(clientHintsFor('linkedin')['sec-ch-ua-mobile'], '?0');
  assert.equal(clientHintsFor('x')['sec-ch-ua-mobile'], '?0');
});
t('Client-hints: exactly the 3 native hint headers (no fabricated 4th)', () => {
  const h = clientHintsFor('linkedin');
  assert.deepEqual(Object.keys(h).sort(), ['sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform']);
});

// ---- Engine (A/B layer) ---------------------------------------------------
t('Engine: activeEngine defaults to chromium', () => {
  // ORGANIC_ENGINE unset in this test env → chromium.
  assert.equal(activeEngine(), 'chromium');
});
t('Engine: camofoxUserIdFor derives a stable, unique id per account', () => {
  const a = camofoxUserIdFor({ accountKey: 'linkedin:bob' });
  const b = camofoxUserIdFor({ accountKey: 'linkedin:hanna' });
  const c = camofoxUserIdFor({ accountKey: 'x:bob' });
  assert.equal(a, 'w1408-linkedin-bob');
  assert.notEqual(a, b, 'different personas must not collide');
  assert.notEqual(a, c, 'different platforms must not collide');
});
t('Engine: camofoxUserIdFor falls back to platform:persona when no accountKey', () => {
  assert.equal(camofoxUserIdFor({ platform: 'x', persona: 'hanna' }), 'w1408-x-hanna');
});
t('Engine: config engine value is one of the known engines', () => {
  // config.js normalizes ORGANIC_ENGINE; in this env it is the default.
  assert.ok(['chromium', 'camofox'].includes(ORGANIC_CONFIG.engine), `unexpected engine: ${ORGANIC_CONFIG.engine}`);
});

// ---- Fingerprint wave: userAgentData / connection / caches ----------------
// Static checks on the GENERATED init script (offline, no browser launch):
// assert the new obfuscation wave is present AND internally coherent.
t('Fingerprint wave: userAgentData patch is present in the init script', () => {
  const script = fingerprintInitScript(userAgentFor('linkedin'), 'linkedin');
  assert.ok(script.includes("navigator.userAgentData"), 'userAgentData patch missing');
  assert.ok(script.includes('getHighEntropyValues'), 'getHighEntropyValues missing');
  assert.ok(script.includes('fullVersionList'), 'fullVersionList missing');
  assert.ok(script.includes('getArch'), 'getArch missing');
});

t('Fingerprint wave: userAgentData brands MATCH the Sec-Ch-Ua header (no cross-signal drift)', () => {
  const script = fingerprintInitScript(userAgentFor('linkedin'), 'linkedin');
  const hintHeader = clientHintsFor('linkedin')['sec-ch-ua'];
  // The header carries "Chromium";v="151", "Not_A Brand";v="24", "Google Chrome";v="151".
  // The init script's brands must use the SAME major + the same Not_A Brand 24.
  const major = (hintHeader.match(/"Google Chrome";v="(\d+)"/) || [])[1];
  assert.ok(major, 'could not parse major from Sec-Ch-Ua header');
  // Both "Google Chrome", version: <major> and Not_A Brand 24 must appear in the script.
  assert.ok(new RegExp(`brand: 'Google Chrome', version: chromeMajor`).test(script) || script.includes("'Google Chrome'"), 'Google Chrome brand missing');
  assert.ok(script.includes("'Not_A Brand', version: '24'"), 'Not_A Brand 24 missing');
  assert.ok(script.includes(`chromeMajor`), 'chromeMajor var not threaded into script');
  // platform alignment: linkedin → macOS
  assert.ok(script.includes('macOS'), 'userAgentData platform should be macOS for linkedin');
});

t('Fingerprint wave: Windows platform yields Win platform in userAgentData', () => {
  const script = fingerprintInitScript(userAgentFor('x'), 'x');
  assert.ok(script.includes('Windows'), 'userAgentData platform should be Windows for x');
});

t('Fingerprint wave: connection patch forces non-zero rtt + wifi type', () => {
  const script = fingerprintInitScript(userAgentFor('linkedin'), 'linkedin');
  assert.ok(script.includes("rtt"), 'connection rtt patch missing');
  assert.ok(script.includes("rtt: 50") || script.includes('rtt: stable.rtt'), 'non-zero rtt missing');
  assert.ok(script.includes("type: 'wifi'") || script.includes("stable.type"), 'wifi type missing');
});

t('Fingerprint wave: caches patch present', () => {
  const script = fingerprintInitScript(userAgentFor('linkedin'), 'linkedin');
  assert.ok(script.includes('window.caches'), 'caches patch missing');
});

t('Fingerprint wave: IIFE references no Node-only vars (would throw at page time)', () => {
  // Regression guard: the userAgentData block must use the injected
  // `platformVersion`, NOT the Node-side `isMac` (which doesn't exist in-page
  // and would throw "ReferenceError: isMac is not defined", silently skipping
  // the whole patch). NOTE: the frame-geometry block legitimately declares its
  // OWN in-page `const isMac = /Macintosh|.../`, so we scope this check to the
  // userAgentData block only.
  for (const pf of ['linkedin', 'x']) {
    const script = fingerprintInitScript(userAgentFor(pf), pf);
    const noComments = script.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    // Extract just the userAgentData block (from its guard to the defineProperty).
    const start = noComments.indexOf("typeof navigator.userAgentData === 'undefined'");
    assert.ok(start >= 0, `userAgentData guard missing (${pf})`);
    const block = noComments.slice(start, noComments.indexOf("Object.defineProperty(navigator, 'userAgentData'", start));
    assert.ok(!/\bisMac\b/.test(block), `userAgentData block references Node-only 'isMac' (${pf}) — would throw at page time`);
    assert.ok(/\bplatformVersion\b/.test(block), `userAgentData block should use injected 'platformVersion' (${pf})`);
    // Every constant the patch needs must be injected into the preamble.
    for (const c of ['navPlatform', 'chPlatform', 'chromeMajor', 'archInfo', 'platformVersion']) {
      assert.ok(new RegExp(`const ${c} =`).test(noComments), `injected constant '${c}' missing from preamble (${pf})`);
    }
  }
});

console.log(`\n${failed === 0 ? '✅ ALL PASS' : '❌ FAILURES'}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
