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
 *
 * Usage:
 *   node validate-prompt.mjs <persona> <prompt-file-or-->
 *   node validate-prompt.mjs hanna -          # read prompt from stdin
 *   node validate-prompt.mjs hanna prompt.txt
 *
 * Exit 0 = pass, exit 1 = fail (prints violations to stderr).
 */

import { readFileSync } from 'node:fs';
import { PERSONAS } from './persona-address.mjs';

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
