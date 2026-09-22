#!/usr/bin/env node
/**
 * site-preflight.mjs — Wave D: pre-dispatch target qualification.
 *
 * WHY THIS EXISTS
 *   Round 5 lost ~30 min on Gotain: the domain does not exist (NXDOMAIN),
 *   but the subagent only discovered this inside the browser flow. Pre-flight
 *   catches dead/walled targets BEFORE a subagent is spawned.
 *
 * USAGE
 *   node src/site-preflight.mjs https://www.stoffkontor.de/ https://www.gotain.de/
 *
 *   Exit code 0 = all targets orderable; 1 = at least one hard-fail.
 *   Output: one JSON object per line (NDJSON) so it can be piped.
 *
 * CHECKS PER TARGET
 *   1. DNS          A/AAAA resolution (NXDOMAIN => hard fail)
 *   2. HTTP         status code (via residential egress when possible)
 *   3. CAPTCHA      g-recaptcha / hcaptcha / turnstile / friendlycaptcha markers
 *   4. PLATFORM     heuristics: Shopify / WooCommerce / Shopware / custom
 *
 * CAPTCHA presence is a SOFT flag (some sites render it lazily / only on
 * submit) — orderable=false only for hard fails (NXDOMAIN, 403, 5xx,
 * bot-wall text). CAPTCHA targets are returned with a `captcha` field so
 * the orchestrator can route them to the blocked list.
 */

const { execFileSync } = await import('node:child_process');
const url = (u) => { try { return new URL(u); } catch { return null; } };

function dnsCheck(hostname) {
  // macOS + Linux: prefer dig (present on both), fall back to nslookup.
  for (const [cmd, args] of [
    ['dig', [hostname, '+short', '+time=5', '+tries=2']],
    ['nslookup', [hostname]],
  ]) {
    try {
      const out = execFileSync(cmd, args, { encoding: 'utf8', timeout: 15000 }).trim();
      // dig +short on NXDOMAIN → empty stdout, exit 0.
      if (!out) return { ok: false, error: 'NXDOMAIN' };
      const ip = (out.split(/\s+/).find((l) => /^\d+\.\d+\.\d+\.\d+$/.test(l)) ||
                  out.split(/\s+/).find((l) => /^[0-9a-f]{2,4}:/.test(l)));
      if (ip) return { ok: true, ip };
      if (/no answer|NXDOMAIN|server can't find|name server unknown/i.test(out)) {
        return { ok: false, error: 'NXDOMAIN' };
      }
    } catch {
      continue; // try next resolver
    }
  }
  return { ok: false, error: 'dns-error' };
}

async function httpCheck(targetUrl) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
    'Accept-Language': 'de-DE,de;q=0.9',
  };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(targetUrl, { headers, redirect: 'follow', signal: ctrl.signal });
    const body = (await res.text().catch(() => '')).slice(0, 200_000);
    const lower = body.toLowerCase();
    const captcha = {
      gRecaptcha: /g-recaptcha|grecaptcha\.execute|recaptcha\/api2?\/.js/.test(lower),
      hCaptcha: /hcaptcha|h-captcha/.test(lower),
      turnstile: /challenges\.cloudflare\.com\/turnstile/.test(lower),
      friendlyCaptcha: /friendlycaptcha/.test(lower),
    };
    const platform =
      /cdn\.shopify\.com|shopify\/theme|\/cdn-cgi\/shopify/.test(lower) ? 'shopify' :
      /woocommerce|wp-content\/plugins\/woocommerce/.test(lower) ? 'woocommerce' :
      /shopware|sw-context|shopware5|\/shopware-6/.test(lower) ? 'shopware' :
      /shop-perf|\/checkout\/cn\//.test(lower) ? 'shopware' :
      /astro|__astro/.test(lower) ? 'astro' :
      /svelte|svelte\:/.test(lower) ? 'svelte' :
      'custom';
    const botWall = /are you a robot|unusual traffic|access denied|cf-browser-verification|please enable js/.test(lower) && res.status >= 400;
    return {
      ok: res.status >= 200 && res.status < 400,
      status: res.status,
      finalUrl: res.url,
      captcha,
      platform,
      botWall,
      title: (body.match(/<title[^>]*>([^<]{0,120})/i)?.[1] || '').trim(),
    };
  } catch (e) {
    return { ok: false, status: 0, error: e.name === 'AbortError' ? 'timeout' : e.message.slice(0, 120) };
  } finally {
    clearTimeout(t);
  }
}

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error('usage: site-preflight.mjs <url> [url ...]');
  process.exit(2);
}

let anyFail = false;
for (const t of targets) {
  const u = url(t);
  const out = { target: t };
  if (!u || !/^https?:$/.test(u.protocol)) {
    out.orderable = false; out.hardFail = 'invalid-url'; anyFail = true;
    console.log(JSON.stringify(out));
    continue;
  }
  const dns = dnsCheck(u.hostname);
  out.dns = dns;
  if (!dns.ok) {
    out.orderable = false; out.hardFail = 'dns'; anyFail = true;
    console.log(JSON.stringify(out));
    continue;
  }
  const http = await httpCheck(u.href);
  out.http = http;
  const captchaHit = Object.values(http.captcha || {}).some(Boolean);
  if (!http.ok) {
    out.orderable = false;
    out.hardFail = http.status >= 400 ? `http-${http.status}` : http.error;
    anyFail = true;
  } else if (http.botWall) {
    out.orderable = false; out.hardFail = 'bot-wall'; anyFail = true;
  } else {
    out.orderable = true;
    if (captchaHit) out.captchaWarning = Object.keys(http.captcha).filter((k) => http.captcha[k]);
  }
  console.log(JSON.stringify(out));
}
process.exit(anyFail ? 1 : 0);
