/**
 * CamoFox multi-step Svelte/Astro form runner — Wave B.
 *
 * Drives a multi-step island form (Josera-style: Astro + Svelte 5,
 * client:load, 22 hidden fields mirroring Svelte store state) over the
 * CamoFox HTTP tab API, with the three protections this flow needs:
 *
 *   1. KEEP-ALIVE      — a KeepAlive ping loop (see camofox-keepalive.js)
 *                        runs for the entire flow so the server-side tab
 *                        reaper (TAB_INACTIVITY_MS, default 300 s) can never
 *                        fire while we think/poll/wait between actions.
 *   2. STATE VERIFY    — every step ends with a synchronous read-back:
 *                        active step marker + expected hidden-field values.
 *                        A step is only "done" when the DOM agrees, so we
 *                        never advance on a click that Svelte didn't apply.
 *   3. HIDDEN-FIELD SYNC POLL — after every mutation (click/select/fill),
 *                        poll the 22 hidden mirror inputs (1–2 s cadence,
 *                        up to `syncTimeoutMs`) until the expected value
 *                        lands. Svelte 5 stores update the hidden inputs in
 *                        a microtask — fast, but never trust "fire and
 *                        forget": on a dead/unsynced state the final form
 *                        submission silently omits fields.
 *
 * SUBMIT INTERCEPTION (CamoFox-compatible)
 *   The CamoFox HTTP API has NO Playwright network listener (no
 *   page.waitForResponse). The compatible equivalent: BEFORE clicking
 *   submit, inject an in-page hook that records (a) form submit events and
 *   (b) XHR/fetch requests matching the form's action URL, into
 *   window.__cf_submit_log. After the click, poll that log for the submit
 *   + the confirmation response, AND poll the DOM for the confirmation
 *   marker (order number). This is "explicit submit interception" without a
 *   network listener — see installSubmitHook() below.
 *
 * HARD CONSTRAINTS (learned live, see BROWSER-AUDIT.md)
 *   - /tabs/:id/evaluate does NOT await async functions → all in-page JS
 *     in this file is SYNCHRONOUS IIFEs. Async waiting happens in Node.
 *   - Object results must be JSON.stringify'd in-page and parsed here.
 *
 * USAGE
 *   const { CamoFoxFormRunner } = await import('./camofox-form-runner.js');
 *   const runner = new CamoFoxFormRunner({
 *     request: (m, p, b) => camofox._request(m, p, b),
 *     userId: 'w1408-bob-dog2', tabId,
 *     keepAlive: { intervalMs: 10_000 },
 *     log: console.log,
 *   });
 *   const result = await runner.run(joseraHundSteps);
 *   // result = { ok, submitted, confirmation, steps: [...], syncLog: [...] }
 */

import { KeepAlive } from './camofox-keepalive.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));

/**
 * In-page submit hook. SYNCHRONOUS (no async/await allowed in evaluate).
 * Records form submits + XHR/fetch traffic to the form action so a caller
 * can poll window.__cf_submit_log after clicking submit.
 * Returns 'installed' or 'already'.
 */
export const SUBMIT_HOOK_EXPRESSION = `(function(){
  if (window.__cf_submit_hook) return "already";
  window.__cf_submit_log = window.__cf_submit_log || [];
  window.__cf_submit_hook = true;
  try {
    document.querySelectorAll("form").forEach(function(f){
      if (f.__cf_hooked) return; f.__cf_hooked = true;
      f.addEventListener("submit", function(ev){
        window.__cf_submit_log.push({t:"submit", url: f.action, method: (f.method||"get"), ts: Date.now()});
      });
    });
    var xf = function(orig, kind){
      return function(){
        try {
          var u = (arguments[0] && arguments[0].url) || (typeof arguments[0] === "string" ? arguments[0] : "") || this._url || "";
          window.__cf_submit_log.push({t:kind, url: String(u).substring(0,300), ts: Date.now()});
        } catch(e){}
        return orig.apply(this, arguments);
      };
    };
    if (!window.__cf_xhr_hooked) {
      window.__cf_xhr_hooked = true;
      var O = window.XMLHttpRequest.prototype.open;
      window.XMLHttpRequest.prototype.open = function(m, u){ this._url = u; return O.apply(this, arguments); };
      var S = window.XMLHttpRequest.prototype.send;
      window.XMLHttpRequest.prototype.send = xf(S, "xhr");
      var F = window.fetch;
      if (F) window.fetch = xf(F, "fetch");
    }
  } catch(e){ window.__cf_submit_log.push({t:"hook_error", e: String(e)}); }
  return "installed";
})()`;

export class CamoFoxFormRunner {
  /**
   * @param {object} opts
   * @param {(method: string, path: string, body?: object) => Promise<object>} opts.request
   * @param {string} opts.userId
   * @param {string} opts.tabId
   * @param {object} [opts.keepAlive]  KeepAlive constructor opts ({intervalMs, ...}); pass false to disable.
   * @param {number} [opts.syncPollMs=1000]   Hidden-field sync poll cadence (1–2 s per spec).
   * @param {number} [opts.syncTimeoutMs=4000] Max wait for expected hidden values.
   * @param {number} [opts.stepSettleMs=800]  Dwell after a mutation before first sync poll.
   * @param {number} [opts.actionGapMs=[300,900]] Human-ish gap between actions (tuple).
   * @param {Function} [opts.log]
   */
  constructor({ request, userId, tabId, keepAlive = {}, syncPollMs = 1_000, syncTimeoutMs = 4_000, stepSettleMs = 800, actionGapMs = [300, 900], log = () => {} }) {
    if (!request || !tabId) throw new Error('CamoFoxFormRunner requires request + tabId');
    this.request = request;
    this.userId = userId || '';
    this.tabId = tabId;
    this.syncPollMs = syncPollMs;
    this.syncTimeoutMs = syncTimeoutMs;
    this.stepSettleMs = stepSettleMs;
    this.actionGap = actionGapMs;
    this.log = log;
    this.syncLog = [];
    this.keepsAlive = false;
    this._ka = keepAlive ? new KeepAlive({ tabId, userId, request, log, ...keepAlive }) : null;
  }

  // --- low-level primitives -------------------------------------------------

  /** Synchronous in-page evaluate, JSON-decoded. */
  async _ev(expression) {
    const raw = await this.request('POST', `/tabs/${this.tabId}/evaluate`, {
      userId: this.userId,
      expression: `(function(){ try { return JSON.stringify(${expression}); } catch(e){ return JSON.stringify({__error: String(e)}); } })()`,
    });
    const res = raw && raw.result;
    if (typeof res !== 'string') return res === undefined ? null : res;
    try { return JSON.parse(res); } catch { return { __raw: res }; }
  }

  /** Read the hidden mirror fields → {name: value}. */
  async readHidden() {
    return (await this._ev(
      '(function(){var o={};document.querySelectorAll("input[type=hidden]").forEach(function(e){o[e.name]=e.value});return o})()'
    )) || {};
  }

  /** Click an element by selector (CSS), optionally matching by visible text prefix. Returns {found, text, disabled}. */
  async clickBySelector(selector, textPrefix) {
    const js = `(function(){
      var els = document.querySelectorAll(${JSON.stringify(selector)});
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (${JSON.stringify(textPrefix || '')} && (el.textContent||"").trim().indexOf(${JSON.stringify(textPrefix || '')}) !== 0) continue;
        if (el.disabled) return {found:true, disabled:true};
        el.click();
        return {found:true, text:(el.textContent||"").trim().substring(0,60)};
      }
      return {found:false, count: els.length};
    })()`;
    return await this._ev(js);
  }

  /**
   * Fill a text/number/date input Svelte-reactively: set .value, dispatch
   * input + change events so Svelte 5's $state/element binding picks it up.
   * Plain el.value=... alone does NOT trigger Svelte bindings.
   */
  async fill(selector, value) {
    const js = `(function(){
      var el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return {found:false};
      el.focus();
      el.value = ${JSON.stringify(String(value))};
      el.dispatchEvent(new Event("input", {bubbles:true}));
      el.dispatchEvent(new Event("change", {bubbles:true}));
      el.blur();
      return {found:true, value: el.value};
    })()`;
    return await this._ev(js);
  }

  /** Select an option by exact (or prefix) text in a <select>, Svelte-reactive. */
  async selectOption(selector, textPrefix) {
    const js = `(function(){
      var el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return {found:false};
      for (var i = 0; i < el.options.length; i++) {
        if (el.options[i].text.trim().indexOf(${JSON.stringify(textPrefix)}) === 0) {
          el.value = el.options[i].value;
          el.dispatchEvent(new Event("change", {bubbles:true}));
          el.dispatchEvent(new Event("input", {bubbles:true}));
          return {found:true, selected: el.options[i].text.trim(), value: el.value};
        }
      }
      return {found:true, error:"option not found", options: Array.prototype.map.call(el.options, function(o){return o.text.trim()}).slice(0,12)};
    })()`;
    return await this._ev(js);
  }

  /** Check a radio button by name + (label text prefix OR value). Svelte-reactive. */
  async selectRadio(name, matchText) {
    const js = `(function(){
      var boxes = document.querySelectorAll('input[type=radio][name=' + ${JSON.stringify(name)} + ']');
      for (var i = 0; i < boxes.length; i++) {
        var label = boxes[i].closest("label");
        var text = label ? (label.textContent||"").trim() : "";
        if (!${JSON.stringify(matchText)} || text.indexOf(${JSON.stringify(matchText)}) === 0) {
          boxes[i].checked = true;
          boxes[i].dispatchEvent(new Event("change", {bubbles:true}));
          boxes[i].dispatchEvent(new Event("input", {bubbles:true}));
          return {found:true, text: text.substring(0,40)};
        }
      }
      return {found:false, count: boxes.length};
    })()`;
    return await this._ev(js);
  }

  /**
   * Hidden-field sync poll (spec: 1–2 s cadence).
   * Expected-value sentinels: "__set__" = must be non-empty (value varies by
   * assortment/selection), "__any__" = field must exist. Anything else must
   * match exactly.
   * @param {object} expect  {hiddenFieldName: expectedValue}
   * @returns {ok, missing: [{field, expected, actual, tries}]}
   */
  async waitForHiddenSync(expect, { timeoutMs = this.syncTimeoutMs, pollMs = this.syncPollMs } = {}) {
    const start = Date.now();
    let last = await this.readHidden();
    let tries = 0;
    const matches = (field, expected, actual) => {
      if (expected === '__set__') return actual !== '' && actual != null;
      if (expected === '__any__') return actual != null;
      return actual === expected;
    };
    while (Date.now() - start < timeoutMs) {
      tries++;
      const missing = Object.keys(expect).filter((k) => !matches(k, expect[k], last[k]));
      if (!missing.length) {
        this.syncLog.push({at: Date.now() - start, ok: true, tries});
        return { ok: true, tries };
      }
      await sleep(pollMs);
      last = await this.readHidden();
    }
    const missing = Object.keys(expect).map((k) => ({ field: k, expected: expect[k], actual: last[k] }));
    this.syncLog.push({ at: Date.now() - start, ok: false, tries, missing });
    return { ok: false, tries, missing };
  }

  /** Step state read-back: active progress-step label + visible inputs count. */
  async stepState() {
    return (await this._ev(
      '(function(){var a=document.querySelector(".progress-step.active");return {activeStep: a?(a.textContent||"").trim():"?", url: location.href}})()'
    )) || {};
  }

  /** Human-ish gap between actions. */
  async _gap() { await sleep(rand(this.actionGap[0], this.actionGap[1])); }

  // --- step execution --------------------------------------------------------

  /**
   * Execute one step:
   *   step = {
   *     name,                       // "step-1-produkte"
   *     expectStep,                 // active progress-step label to verify (e.g. "1 Produkte")
   *     actions: [ {type:'click', selector} | {type:'fill', selector, value}
   *                | {type:'select', selector, option} | {type:'radio', name, option}
   *                | {type:'wait', ms} ],
   *     syncExpect: {hiddenName: value, ...},   // poll after actions complete
   *     maxRetries: 1,              // retry the whole step once on state-verify failure
   *   }
   * @returns {ok, attempts, error?, state?}
   */
  async runStep(step) {
    const maxAttempts = 1 + (step.maxRetries || 1);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // 1) verify we are where the step expects to be
      const pre = await this.stepState();
      if (step.expectStep && !String(pre.activeStep || '').includes(step.expectStep)) {
        this.log(`[runner] ${step.name} attempt ${attempt}: NOT on expected step (got "${pre.activeStep}", want "${step.expectStep}")`);
        if (attempt < maxAttempts) { await sleep(1_500); continue; }
        return { ok: false, step: step.name, attempts: attempt, error: `wrong step: "${pre.activeStep}" != "${step.expectStep}"`, state: pre };
      }

      // 2) run the actions
      let actionErr = null;
      for (const a of step.actions || []) {
        await this._gap();
        if (a.type === 'wait') { await sleep(a.ms); continue; }
        let res;
        try {
          if (a.type === 'click') {
            // a.index (0-based) selects the Nth match of the selector (e.g. 2nd product card button)
            if (a.index != null) {
              const js = `(function(){
                var els = document.querySelectorAll(${JSON.stringify(a.selector)});
                var el = els[${a.index}];
                if (!el) return {found:false, count: els.length};
                if (el.disabled) return {found:true, disabled:true};
                el.click();
                return {found:true, text:(el.textContent||"").trim().substring(0,60)};
              })()`;
              res = await this._ev(js);
            } else {
              res = await this.clickBySelector(a.selector, a.textPrefix);
            }
          }
          else if (a.type === 'clickProduct') {
            // Click the action button of the product card whose title starts with a.name
            const js = `(function(){
              var cards = document.querySelectorAll(".product-card");
              for (var i = 0; i < cards.length; i++) {
                var t = (cards[i].textContent||"").trim();
                if (t.indexOf(${JSON.stringify(a.name)}) === 0) {
                  var b = cards[i].querySelector(".product-card-action-button");
                  if (!b) return {found:false, error:"card has no action button"};
                  if (b.disabled) return {found:true, disabled:true};
                  b.click();
                  return {found:true, product: t.substring(0,40), btn: b.textContent.trim()};
                }
              }
              return {found:false, error:"product card not found", name: ${JSON.stringify(a.name)}};
            })()`;
            res = await this._ev(js);
          }
          else if (a.type === 'fill') res = await this.fill(a.selector, a.value);
          else if (a.type === 'select') res = await this.selectOption(a.selector, a.option);
          else if (a.type === 'radio') res = await this.selectRadio(a.name, a.option);
          else { actionErr = `unknown action type ${a.type}`; break; }
        } catch (e) { actionErr = `${a.type} threw: ${e.message}`; break; }
        if (res && res.found === false) { actionErr = `${a.type} target not found: ${a.selector || a.name}`; break; }
        if (res && res.disabled) { actionErr = `${a.type} target disabled: ${a.selector}`; break; }
        if (res && res.error) { actionErr = `${a.type} failed on ${a.selector || a.name}: ${res.error}`; break; }
        this.log(`[runner] ${step.name} ${a.type} ${a.selector || a.name || ''} → ok`);
      }
      if (actionErr) {
        this.log(`[runner] ${step.name} attempt ${attempt}: action error: ${actionErr}`);
        if (attempt < maxAttempts) { await sleep(1_500); continue; }
        return { ok: false, step: step.name, attempts: attempt, error: actionErr };
      }

      // 3) hidden-field sync poll (1–2 s cadence)
      if (step.syncExpect && Object.keys(step.syncExpect).length) {
        await sleep(this.stepSettleMs);
        const sync = await this.waitForHiddenSync(step.syncExpect);
        if (!sync.ok) {
          this.log(`[runner] ${step.name} attempt ${attempt}: hidden sync FAILED: ${JSON.stringify(sync.missing)}`);
          if (attempt < maxAttempts) { await sleep(1_500); continue; }
          return { ok: false, step: step.name, attempts: attempt, error: 'hidden-field sync failed', missing: sync.missing };
        }
        this.log(`[runner] ${step.name} hidden sync ok after ${sync.tries} poll(s)`);
      }

      // 4) post-step state verify
      const post = await this.stepState();
      const expectedAfter = step.verifyStep || step.expectStep;
      if (expectedAfter && !String(post.activeStep || '').includes(expectedAfter) && !step.optionalAdvance) {
        // Some steps advance the wizard (their action IS the "next" button);
        // if the action already advanced us, verify the NEXT step instead.
        if (step.expectNext && String(post.activeStep || '').includes(step.expectNext)) {
          this.log(`[runner] ${step.name} advanced to "${post.activeStep}" as expected`);
        } else if (attempt < maxAttempts) {
          await sleep(1_500); continue;
        } else {
          return { ok: false, step: step.name, attempts: attempt, error: `state verify failed: "${post.activeStep}"`, state: post };
        }
      }
      return { ok: true, step: step.name, attempts: attempt, state: post };
    }
  }

  /**
   * Run the full flow: start keep-alive, execute steps sequentially,
   * install submit hook, click submit, intercept via in-page log + DOM poll.
   *
   *   submit = {
   *     selector,            // final submit button
   *     confirmMarkers: ["Bestellnummer", "Danke"],   // DOM text that proves success
   *     confirmTimeoutMs: 45_000,
   *     confirmPollMs: 2_000,
   *   }
   * Pass submit=false to STOP at the final step without submitting (dry run).
   */
  async run(steps, { submit = null } = {}) {
    const results = [];
    if (this._ka) { this._ka.start(); this.keepsAlive = true; }
    const flowStart = Date.now();
    try {
      for (const step of steps) {
        const r = await this.runStep(step);
        results.push(r);
        if (!r.ok) {
          return { ok: false, submitted: false, steps: results, durationMs: Date.now() - flowStart, failedAt: step.name, error: r.error };
        }
      }
      if (!submit) {
        this.log('[runner] dry run: all steps verified, NOT submitting');
        return { ok: true, submitted: false, dryRun: true, steps: results, durationMs: Date.now() - flowStart };
      }

      // ---- explicit submit interception (in-page hook; no network listener in CamoFox API)
      const hook = await this._ev(SUBMIT_HOOK_EXPRESSION);
      this.log(`[runner] submit hook: ${hook}`);
      await this.clickBySelector(submit.selector);
      const start = Date.now();
      let lastLog = [];
      while (Date.now() - start < submit.confirmTimeoutMs) {
        await sleep(submit.confirmPollMs);
        const s = await this._ev(
          `(function(){
            var log = window.__cf_submit_log || [];
            var body = document.body ? document.body.innerText : "";
            var marker = null;
            ${JSON.stringify(submit.confirmMarkers)}.forEach(function(m){ if (body.indexOf(m) !== -1) marker = m; });
            var orderNum = (body.match(/Bestellnummer[#:\\s]*([A-Za-z0-9-]{4,})/i) || [])[1] || null;
            return {log: log.slice(-10), marker: marker, orderNum: orderNum, url: location.href};
          })()`
        );
        lastLog = (s && s.log) || [];
        if (s && s.marker) {
          this.log(`[runner] SUBMIT CONFIRMED: marker="${s.marker}" orderNum=${s.orderNum} url=${s.url}`);
          return { ok: true, submitted: true, steps: results, confirmation: { marker: s.marker, orderNum: s.orderNum, url: s.url, submitLog: lastLog }, durationMs: Date.now() - flowStart };
        }
        if (s && s.orderNum && !s.marker) {
          this.log(`[runner] SUBMIT CONFIRMED via order number: ${s.orderNum}`);
          return { ok: true, submitted: true, steps: results, confirmation: { orderNum: s.orderNum, url: s.url, submitLog: lastLog }, durationMs: Date.now() - flowStart };
        }
      }
      return { ok: false, submitted: false, steps: results, error: 'submit confirmation timed out', submitLog: lastLog, durationMs: Date.now() - flowStart };
    } finally {
      if (this._ka) { this._ka.stop(); this.keepsAlive = false; }
    }
  }
}

// =============================================================================
// Josera Hund (https://www.josera-hundefutter-probe.de/) — concrete step plan.
// Verified live 2026-09-22 (Astro + Svelte 5 island, client:load, 22 hidden
// mirror inputs, 4 progress steps). DO-NOT-REORDER: use only for a NEW
// persona/pet; the ledger tracks ordered combos.
//
//   Step 1 Produkte   : .step-btn ×3 (Futterberater filters) + EXACTLY 2
//                       .product-card-action-button clicks (button is disabled
//                       until 2 products are selected — "Bitte wähle genau 2
//                       Produkte aus, um fortzufahren").
//   Step 2 Tierdaten  : #animal-name, #animal-breed (select), #animal-birthdate
//                       (date, optional), radio name=gender, #animal-weight
//                       (number), #animal-activity (select) → next-step-button.
//   Step 3 Adresse    : salutation/firstname/lastname/street_and_number/postcode/
//                       city/phone/email (+ terms where the site puts them).
//   Step 4 Bestätigung: review + terms checkbox + submit.
// =============================================================================

export const JOSERA_DOG_STEPS = [
  {
    name: 'step-1-produkte',
    expectStep: '1 Produkte',
    expectNext: '1 Produkte', // stays on step 1 until 2 products selected
    actions: [
      { type: 'click', selector: '.step-btn', textPrefix: 'Adult' },        // Futterberater filters (narrow product list)
      { type: 'click', selector: '.step-btn', textPrefix: 'Mittlere Rasse' },
      { type: 'click', selector: '.step-btn', textPrefix: 'Moderat' },
      { type: 'clickProduct', name: 'Duck & Potato' },                      // product #1
      { type: 'wait', ms: 800 },
      { type: 'clickProduct', name: 'Festival' },                           // product #2
    ],
    // NOTE: .step-btn clicks are the Futterberater FILTERS (they narrow the
    // product list; they do NOT sync pet_weight/pet_activity_level — those
    // come from the Step-2 inputs). Only the 2 product selections sync hidden fields.
    syncExpect: { sample_order_1: '__set__', sample_order_2: '__set__', pet_type: 'Dog' },
  },
  {
    name: 'step-1-advance',
    expectStep: '1 Produkte',
    expectNext: '2 Tierdaten',
    actions: [{ type: 'click', selector: '.next-step-button' }],
  },
  {
    name: 'step-2-tierdaten',
    expectStep: '2 Tierdaten',
    expectNext: '2 Tierdaten',
    actions: [
      { type: 'fill', selector: '#animal-name', value: 'Rex' },
      { type: 'select', selector: '#animal-breed', option: 'Beagle' },
      { type: 'fill', selector: '#animal-birthdate', value: '2023-05-14' },
      { type: 'radio', name: 'gender', option: 'Rüde' },  // labels are Hündin / Rüde
      { type: 'fill', selector: '#animal-weight', value: '12.5' },
      { type: 'select', selector: '#animal-activity', option: 'normal aktiv' },
    ],
    syncExpect: { pet_name: 'Rex', pet_breed: '__set__', pet_weight: '__set__', pet_activity_level: '__set__', pet_gender: '__set__' },
  },
  {
    name: 'step-2-advance',
    expectStep: '2 Tierdaten',
    expectNext: '3 Adresse',
    actions: [{ type: 'click', selector: '.next-step-button' }],
  },
  // Step 3 address fields: selectors to be bound on first live run (see
  // runStep state reads); the hidden-field names below are the contract.
  {
    name: 'step-3-adresse',
    expectStep: '3 Adresse',
    expectNext: '3 Adresse',
    actions: [
      // Fill via name= attribute (Svelte island uses name-bound inputs):
      { type: 'fill', selector: 'input[name="firstname"]', value: 'Bob' },
      { type: 'fill', selector: 'input[name="lastname"]', value: 'Scheugenpflug' },
      { type: 'fill', selector: 'input[name="street_and_number"]', value: 'Besenbruck 1' },
      { type: 'fill', selector: 'input[name="postcode"]', value: '93176' },
      { type: 'fill', selector: 'input[name="city"]', value: 'Beratzhausen' },
      // email + phone if present on the step (fill by name when visible)
    ],
    syncExpect: { firstname: 'Bob', lastname: 'Scheugenpflug', street_and_number: 'Besenbruck 1', postcode: '93176', city: 'Beratzhausen', email: '__set__' },
  },
  {
    name: 'step-3-advance',
    expectStep: '3 Adresse',
    expectNext: '4 Bestätigung',
    actions: [{ type: 'click', selector: '.next-step-button' }],
  },
  {
    name: 'step-4-bestätigung',
    expectStep: '4 Bestätigung',
    expectNext: '4 Bestätigung',
    actions: [
      { type: 'click', selector: 'input[type="checkbox"][name="terms_accepted"]' },
    ],
    syncExpect: { terms_accepted: 'yes' },
  },
];

export default CamoFoxFormRunner;
