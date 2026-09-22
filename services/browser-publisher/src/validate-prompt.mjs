#!/usr/bin/env node
/**
 * Preflight prompt validator — run BEFORE dispatching any subagent that orders
 * free samples, fills forms, or otherwise uses persona identity data.
 *
 * Gates:
 *   1. Persona identity — the prompt MUST contain the exact name + address
 *      markers from persona-address.js (no placeholders like "Musterstraße").
 *   2. Ledger guard — the prompt MUST instruct the subagent to skip already-
 *      ordered sites (reads FREE-SAMPLE-LEDGER.md).
 *   3. Egress check — the prompt MUST mention residential egress / proxy if
 *      the task involves browser interaction.
 *   4. DNS pre-check — every domain in the prompt must resolve (NXDOMAIN
 *      = hard fail). Dead domains waste 30+ min of subagent runtime.
 *
 * Usage:
 *   node validate-prompt.mjs <persona> <prompt-file-or-->
 *   node validate-prompt.mjs hanna -          # read prompt from stdin
 *   node validate-prompt.mjs hanna prompt.txt
 *
 * Exit 0 = pass, exit 1 = fail (prints violations to stderr).
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { PERSONAS } from './persona-address.mjs';

// Wave D: DNS resolution — dig (macOS + Linux) with nslookup fallback.
// Returns 'ok', 'NXDOMAIN', or 'error'.
function dnsResolve(hostname) {
  for (const [cmd, args] of [
    ['dig', [hostname, '+short', '+time=4', '+tries=2']],
    ['nslookup', [hostname]],
  ]) {
    try {
      const out = execFileSync(cmd, args, { encoding: 'utf8', timeout: 12000 }).trim();
      if (!out) return 'NXDOMAIN'; // dig +short → empty on NXDOMAIN
      const hasIp = out.split(/\s+/).some((l) => /^\d+\.\d+\.\d+\.\d+$/.test(l) || /^[0-9a-f]{2,4}:/.test(l));
      if (hasIp) return 'ok';
      if (/no answer|NXDOMAIN|server can't find|name server unknown/i.test(out)) return 'NXDOMAIN';
    } catch {
      continue;
    }
  }
  return 'error';
}

// Extract all hostnames referenced in the prompt (http(s) URLs + bare .de/.com etc).
function extractDomains(prompt) {
  const domains = new Set();
  for (const m of prompt.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) {
    domains.add(m[1].toLowerCase());
  }
  for (const m of prompt.matchAll(/\b([a-z0-9-]+\.(?:de|com|net|org|eu|shop|store|io))(?=[\s/)\]|,;]|$)/gi)) {
    domains.add(m[1].toLowerCase());
  }
  // Drop subdomains? No — check the full hostname as written (www vs apex can differ).
  return [...domains];
}

const FORBIDDEN_GLOBAL = [
  'musterstraße',
  'musterstr.',
  'placeholder',
  'todo',
  'tbd',
  'fill in',
  'insert address',
  'example.com',
  'john doe',
  'max mustermann',
];

function readPrompt(arg) {
  if (arg === '-' || !arg) {
    return readFileSync(0, 'utf-8');
  }
  return readFileSync(arg, 'utf-8');
}

function main() {
  const persona = process.argv[2];
  const promptArg = process.argv[3] || '-';
  
  if (!persona || !PERSONAS[persona]) {
    console.error(`ERROR: Unknown persona "${persona}". Valid: ${Object.keys(PERSONAS).join(', ')}`);
    process.exit(1);
  }
  
  const p = PERSONAS[persona];
  let prompt;
  try {
    prompt = readPrompt(promptArg);
  } catch (e) {
    console.error(`ERROR: Cannot read prompt from ${promptArg}: ${e.message}`);
    process.exit(1);
  }
  
  const lower = prompt.toLowerCase();
  const violations = [];
  
  // --- Gate 1: Persona identity markers ---
  for (const marker of p.prompt_markers) {
    if (!prompt.includes(marker)) {
      violations.push(
        `MISSING IDENTITY: prompt does not contain "${marker}" — ` +
        `the subagent will not know the real ${persona} address and will ` +
        `fall back to a placeholder.`
      );
    }
  }
  
  // --- Gate 1b: Forbidden placeholders ---
  const allForbidden = [...p.prompt_forbidden, ...FORBIDDEN_GLOBAL];
  for (const bad of allForbidden) {
    if (lower.includes(bad.toLowerCase())) {
      violations.push(
        `FORBIDDEN PLACEHOLDER: prompt contains "${bad}" — ` +
        `this is a placeholder, not real persona data.`
      );
    }
  }
  
  // --- Gate 1c: Email consistency ---
  // If the prompt mentions an email, it must be one of the persona's real emails.
  const emailMatches = prompt.match(/[\w.+-]+@[\w.-]+\.\w+/g) || [];
  const allowedEmails = [p.email_corporate, p.email_personal, p.email_central]
    .filter(Boolean)
    .map((e) => e.toLowerCase());
  for (const found of emailMatches) {
    // Allow generic/functional emails that aren't persona-bound
    if (found.includes('noreply') || found.includes('example.')) continue;
    if (!allowedEmails.includes(found.toLowerCase()) && 
        !found.endsWith('@sofacompany.com') && // vendor emails in context
        !found.endsWith('@naturstoff.de') &&
        !found.includes('info@') &&
        !found.includes('support@') &&
        !found.includes('admin@')) {
      violations.push(
        `UNKNOWN EMAIL: prompt references "${found}" which is not a known ` +
        `${persona} email. Allowed: ${allowedEmails.join(', ')}`
      );
    }
  }
  
  // --- Gate 2: Ledger guard ---
  if (!lower.includes('ledger') && !lower.includes('already ordered') && 
      !lower.includes('do not reorder') && !lower.includes('skip')) {
    violations.push(
      `MISSING LEDGER GUARD: prompt does not mention the order ledger or ` +
      `instruct the subagent to skip already-ordered sites — ` +
      `risk of spamming vendors with duplicate free-sample requests.`
    );
  }
  
  // --- Gate 3: Egress awareness (for browser tasks) ---
  if (lower.includes('browse') || lower.includes('browser') || 
      lower.includes('form') || lower.includes('order')) {
    if (!lower.includes('egress') && !lower.includes('proxy') && 
        !lower.includes('residential') && !lower.includes('socks5')) {
      violations.push(
        `MISSING EGRESS CONTEXT: prompt involves browser/form interaction ` +
        `but does not mention residential egress or proxy — ` +
        `the subagent may route through the datacenter IP.`
      );
    }
  }
  
  // --- Gate 4: DNS pre-check (Wave D) ---
  // Dead domains (NXDOMAIN) fail INSIDE the subagent run, wasting 30+ minutes.
  // Catch them here at preflight. Example: gotain.de = NXDOMAIN (Round 5).
  const domains = extractDomains(prompt);
  for (const d of domains) {
    const status = dnsResolve(d);
    if (status === 'NXDOMAIN') {
      violations.push(
        `DEAD DOMAIN: "${d}" does not resolve (NXDOMAIN) — ` +
        `remove it from the target list before dispatching the subagent.`
      );
    } else if (status === 'error') {
      console.error(`⚠ DNS check inconclusive for ${d} (resolver error) — not blocking`);
    }
  }
  
  // --- Result ---
  if (violations.length > 0) {
    console.error('═══ PREFLIGHT VALIDATION FAILED ═══');
    console.error(`Persona: ${persona} (${p.ordering_name})`);
    console.error(`Violations: ${violations.length}\n`);
    for (const v of violations) {
      console.error(`  ✗ ${v}\n`);
    }
    console.error('═══ END VALIDATION ═══');
    process.exit(1);
  }
  
  console.error(`✓ PREFLIGHT PASS — persona: ${persona}, markers: ${p.prompt_markers.length}, prompt: ${prompt.length} chars`);
  process.exit(0);
}

main();
