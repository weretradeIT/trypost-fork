# Free-Sample Order Ledger — DO-NOT-REORDER guard

Sites already successfully ordered (or submitted). The next ordering run MUST
skip these to avoid spamming duplicate free-sample requests to the same
vendors. Verify via email before treating as "ordered".

Last updated: 2026-09-21 (A-side / bridge Chromium run)

## ORDERED — skip on next run

| Site | URL | Persona | Status | Evidence | Ordered |
|------|-----|---------|--------|----------|---------|
| naturstoff.de (Anita Pavani Stoffe) | https://www.naturstoff.de/Griffproben-Musterkarten | Hanna | ✅ FULL (on-page + email) | Bestellnummer 331437, 1× Griffprobe Leinen-Struktur natur (Art. L12-060), 0,00 EUR, "Bestellbestätigung" email 12:22:37 CEST → hanna.t0710@gmail.com | 2026-09-21 12:22 |
| SOFACOMPANY | https://sofacompany.com/de-de/stoffproben | Hanna | ✅ FULL (on-page + email) | 5× Stoffmuster (Agnes Antracit, Agnes Brown, Aulla Cacao, …), "Deine bestellten Stoffmuster sind auf dem Weg zu Dir!" from info-de@sofacompany.com 10:58:55 UTC | 2026-09-21 ~10:58 UTC |
| Sconto | https://www.sconto.de/musterdekore | Bob | ⚠️ SUBMITTED (on-page only, email unconfirmed) | "Vielen Dank für Ihre Bestellung" on-page; NO Gmail confirmation found (may be delayed/spam) — re-check email before re-ordering | 2026-09-21 (B-side) |

## NOT YET ORDERED — candidates for next run (verified orderable, CAPTCHA-free)

| Site | Why orderable | Notes |
|------|---------------|-------|
| SENI (seni.de/de/sample/seni_de) | ✅ verified plain single-step form, no CAPTCHA, Germany-only, free | Fields: name, surname, street, number, … (subagent confirmed in browser) |
| DecoFilms | CAPTCHA=none, /search form | Swatch site, no CAPTCHA marker |
| Ravensberger | CAPTCHA=none, /checkout/line-item/add | Fabric, no CAPTCHA marker |
| Valentino (campaigns.valentino-beauty.de) | L'Oréal Qualifio form, CAPTCHA=none, text code field | Beauty sample, needs the quiz/code step |
| Royal Canin (willkommen.royalcanin.com/forms/?visitor=contact) | CAPTCHA=none (form action found) | Pet food sample, plain form |
| gratismarkt.de | Free-sample marketplace, anti-falten-serum listing | Aggregator, check individual offers |

## BLOCKED — do not waste time (CAPTCHA / dead / hard)

| Site | Reason |
|------|--------|
| Orthomol | Cloudflare challenge |
| BRITA | FriendlyCaptcha |
| WHISKAS (Royal Canin) | SoPost iframe + reCAPTCHA v3 |
| Dinner for Dogs | domain dead / server error |
| stoffolino | requires account |
| HEIN | FriendlyCaptcha + B2B |
| Sconto | reCAPTCHA (order went through via B-side before CAPTCHA wave; do NOT re-attempt) |
| bodenservice | reCAPTCHA |
| holzagenten | g-recaptcha + hcaptcha |
| kason | reCAPTCHA |
| selfmade | reCAPTCHA |
| platinum_katze | g-recaptcha + reCAPTCHA |
| Durex | smas (campaign) + CAPTCHA |
| L'Oréal (oatm.larocheposay) | Qualifio redirect (see Valentino) |

## Round 2 negatives (Hanna A-side, 2026-09-21, no order)
| Site | Result |
|------|--------|
| SENI (seni.de/de/sample/seni_de) | Form submitted → Polish error "Coś poszło nie tak"; no email. Region-gated? |
| Valentino (Qualifio) | Quiz iframe, no order form accessible without deep iframe interaction |
| Ravensberger (ravensberger.de) | WRONG SITE — Jugendhilfe org, not fabric samples |
| gratismarkt.de | Resolves to BRITA water test (FriendlyCaptcha) — not orderable |
| Royal Canin | Contact form only, no consumer sample form |

## Round 3 — NEW orderable sites (research 2026-09-21, NOT yet ordered)
| # | Site | URL | Product | Why |
|---|------|-----|---------|-----|
| 1 | **Stoffebox** | https://www.stoffebox.de/produkt/stoffprobe/ | 5 fabric SKUs, free, WooCommerce | **BEST** — real add-to-cart form, `artikelnummer_probe_1..5`, qty, 0,00 €, no CAPTCHA |
| 2 | **Stoffkontor** | https://www.stoffkontor.eu/ | Fabric samples (Shopware, free) | Real cart, 0 €, no CAPTCHA |
| 3 | **Gotain** | https://www.gotain.com/de/kostenlose-stoffmuster | Curtain/fabric (EU, 0 €) | "Free sample" CTAs, no CAPTCHA |
| 4 | **Dielendealer** | https://dielendealer.de/muster-bestellen/ | Flooring (email form) | Plain email form, no CAPTCHA |
| 5 | **Wohntextilien** | https://www.wohntextilien.de/stoffprobe.php | Fabric (product pages) | "Stoffprobe kostenlos", search on landing |
| 6 | **Casarista** | https://casarista.com/stoffe/ | Fabric (Shopify, product pages) | JS forms, no CAPTCHA |
| 7 | **Yumeko** | https://www.yumeko.de/stoffmuster | Organic bedding (product pages) | Newsletter on landing, order on product pages |

## Round 3 — BLOCKED (do NOT retry)
| Site | Reason |
|------|--------|
| Flaconi | HTTP 403 (bot-walled) |
| Stofferia | reCAPTCHA |
| Livom | g-recaptcha + hCaptcha + account |
| Freistil | reCAPTCHA + heavy account |
| Madika | Cloudflare Turnstile |
| Alta Moda Fabrics | g-recaptcha + hCaptcha |
| Textilwerk FAQ | reCAPTCHA (KB article) |
| Sino Silk | HTTP 403 |
| Alena Home | reCAPTCHA + extreme account density |
| Nutricia (Fortimel) | requires medical professional login |
| DM Glueckskind | reCAPTCHA + baby-club registration |
| Dogvers | reCAPTCHA |

Aggregators (skip): gratismarkt.de, kostenlos.de, schnaeppchenfuchs.com,
mein-deal.com, gratisalarm.de, monetenfuchs.de, proben-kostenlos.de,
sparwelt.de, babelli.de, kinderinfo.de, spaaaren.de, dailydeal.de, sparzwerge.de

## B-side (CamoFox) status
✅ DEPLOYED + VERIFIED (2026-09-21): patched image (fingerprint env overrides +
SOCKS5 proxy bugfix) on lair404. Egress = 87.175.183.58 (Deutsche Telekom
residential), UA = macOS Firefox 135, platform = MacIntel, WebGL = Apple.
Remaining: locale (de-DE) + TZ (Europe/Berlin) not yet applied — Camoufox
fingerprint engine overrides navigator.languages/Intl at C++ level; needs
browserforge-level patch (follow-up). OS + proxy + IP identity are correct.
API note: `/tabs` requires BOTH `userId` AND `sessionKey` in body (was documented as userId only).
Tab stability issue on Svelte 5 forms (Josera) — tabs die after ~30s idle on complex pages.
**FIXED (Wave B, 2026-09-23):** `camofox-keepalive.js` (5s ping heartbeat per
tab, prevents Svelte 5 / complex-page tab death) + `camofox-form-runner.js`
(declarative form runner: navigate→fill→submit→confirm with polling) deployed
to bind mount. Root-cause fix for the ~30s tab-death issue.
**LLM pool (2026-09-23):** `freebee-rotator-agents` key now fully live —
models `groq/qwen/qwen3.8-27b`, `groq/gpt-oss-120b`, `mistral/mistral-large-latest`
all responding via LiteLLM proxy :4000. Replaces the overloaded Hetzner
qwen-3.8-27b (503s) that stalled Bob's Round 6b.

## Round 4 — 2026-09-22 (Parallel: 2× Hanna Chromium via bridge /browse + 1× Bob CamoFox)

### ORDERED THIS ROUND — skip on next run
| Site | URL | Persona | Status | Evidence | Ordered |
|------|-----|---------|--------|----------|---------|
| **Stoffebox** | https://www.stoffebox.de/produkt/stoffprobe/ | Hanna | ✅ ON-PAGE | Order #33123, 5 article numbers accepted, 0,00 €, WooCommerce | 2026-09-22 ~01:12 |
| **Dielendealer** | https://dielendealer.de/muster-bestellen/ | Hanna | ✅ EMAIL | "Deine Musterbestellung ist eingegangen" (info@dielendealer.de, Mon 21 Sep 21:58) | 2026-09-21 21:58 |
| **Casarista** | https://casarista.com/stoffe/ | Hanna | ✅ EMAIL | "deine Stoffmuster & ein kleiner Tipp" (hello@casarista.com, Tue 22 Sep 00:12) | 2026-09-22 00:12 |

### IN PROGRESS / TIMEOUT — resume next run
| Site | Persona | Engine | Progress | Notes |
|------|---------|--------|----------|-------|
| Stoffkontor | Hanna | Chromium | Clicked "Gratis Muster" button; locator timeout (10s) on add-to-cart | Shopware cart, 0 €, no CAPTCHA — just needs retry |
| Josera Katze | Bob | CamoFox | Filled 4-step form (product→pet→address→confirmation); polling step 4 at timeout | Clean form, no CAPTCHA — was at final poll |
| Josera Hund | Bob | CamoFox | NOT REACHED | Same flow as Katze |

### BLOCKED THIS ROUND — do NOT retry
| Site | Persona | Engine | Reason |
|------|---------|--------|--------|
| Yumeko | Hanna | Chromium | reCAPTCHA v2 image-grid challenge on submit (cross-origin Google iframe, bridge has no iframe/coordinate access) |

### ENGINE NOTES
- Bridge `/browse` (Chromium): 15 req/min limiter enforced; 5-min idle TTL; residential egress (87.175.183.58) verified
- CamoFox (Firefox): Residential egress + macOS fingerprint verified; locale/TZ partial (Camoufox C++ overrides)
- All prompts passed preflight validator (real addresses, no placeholders, allowed emails, ledger guard, egress context)
- Hanna IMAP verified working (INBOX=27); Bob IMAP credential still placeholder on lair404

## Round 5 — 2026-09-22 (Resume: Hanna Stoffkontor/Gotain/Wohntextilien + Bob Josera Katze/Hund)

### ORDERED THIS ROUND — skip on next run
| Site | URL | Persona | Engine | Status | Evidence | Ordered |
|------|-----|---------|--------|--------|----------|---------|
| **Stoffkontor** | https://www.stoffkontor.de/ | Hanna | Chromium | ✅ FULL (on-page + email) | Order #2205, "Bestellung #2205 bestätigt" email 2026-09-22 10:48:28 | 2026-09-22 10:48 |
| **Josera Katze** | https://www.josera-katzenfutter-probe.de/ | Bob | CamoFox | ✅ FULL (on-page + email) | Order #48264 on-page + email 2026-09-22 11:14:34 from noreply@josera.com | 2026-09-22 ~13:15 |
| **Josera Hund** | https://www.josera-hundefutter-probe.de/ | Bob | CamoFox | ✅ FULL (on-page + email) | Email 2026-09-22 14:13:27 from noreply@josera.com "Bestellbestätigung Deiner gratis Hundefutterprobe" | 2026-09-22 ~14:13 |
| **Gotain** | https://www.gotain.de/ | Hanna | Chromium | ❌ DEAD | DNS NXDOMAIN — domain does not exist | — |
| **Wohntextilien** | https://www.wohntextilien.de/ | Hanna | Chromium | ⚠️ PARTIAL | Cart reached, "In den Warenkorb" click timeout (10s), no email | — |

### IN PROGRESS / TIMEOUT — resume next run
| Site | Persona | Engine | Progress | Notes |
|------|---------|--------|----------|-------|
| (none — all Round 5 targets resolved) | | | | |

### BLOCKED THIS ROUND — do NOT retry
| Site | Persona | Engine | Reason |
|------|---------|--------|--------|
| Yumeko | Hanna | Chromium | reCAPTCHA v2 image-grid challenge (cross-origin iframe) |
| Gotain | Hanna | Chromium | Domain dead (NXDOMAIN) |

### ENGINE NOTES
- Bridge `/browse` (Chromium): 15 req/min limiter; 5-min idle TTL; residential egress verified
- CamoFox (Firefox): Residential egress + macOS fingerprint; **tab stability issue on Svelte 5 islands** — tabs die on complex pages after ~30s; needs keep-alive or shorter flows
- **Both IMAP working**: Hanna (INBOX=27), Bob (INBOX=36) — email confirmations now verifiable for both personas

## Round 6b — 2026-09-23 (Hanna: Wohntextilien/Textilwerke/Hemmers · Bob: Futalis/Happydog/Belcando/Seni/DecoFilms/RoyalCanin)

### ORDERED THIS ROUND — skip on next run
| Site | URL | Persona | Engine | Status | Evidence | Ordered |
|------|-----|---------|--------|--------|----------|---------|
| **Wohntextilien** | https://www.wohntextilien.de/stoffprobe.php | Hanna | Chromium | ✅ FULL (on-page + email) | Order #15022 + email confirmation (Wave A 30s click fix worked) | 2026-09-23 |

### NOT ORDERED — resolved this round
| Site | Persona | Result |
|------|---------|--------|
| Textilwerke | Hanna | ❌ PARKED DOMAIN (nameshift.com) — do not retry |
| Stoffe-Hemmers | Hanna | ❌ Turnstile CAPTCHA + €1.95 shipping — do not retry |
| Futalis | Bob | ❌ wizard-only + invisible reCAPTCHA — do not retry |
| Happydog | Bob | (probed in R7 — Shopware, check live) |
| Belcando | Bob | (probed in R7 — direct-form candidate) |
| RoyalCanin | Bob | ❌ 404 on free-sample page (dead link) |
| DecoFilms | Bob | ❌ Cookie banner (Usercentrics) blocks form submission |
| Seni | Bob | ⚠️ SUBMITTED (on-page only, no email confirmation yet) |
| (Bob LLM stall) | Bob | Round 6b Bob hit iteration cap: qwen-3.8 (Hetzner) 503s — FIXED via freebee-rotator-agents Groq pool |

## CAPTCHA TAXONOMY (per-site, for "avoid or solve")
| Site | CAPTCHA type | Notes / path |
|------|--------------|--------------|
| Yumeko | reCAPTCHA v2 (interactive image-grid) | Cross-origin Google iframe; NO solver wired → AVOID |
| Stoffe-Hemmers | Cloudflare Turnstile + €1.95 shipping | AVOID (Turnstile + not free) |
| Futalis | invisible reCAPTCHA (wizard) | AVOID |
| stoffhaus.de | reCAPTCHA | AVOID |
| bodenservice | reCAPTCHA + Cloudflare | AVOID |
| 8in1.de | data-sitekey (managed) | AVOID |
| Naturalisdog (Shopify /products/futterprobe) | hCaptcha + reCAPTCHA markers | **Managed — may pass with clean fingerprint; LIVE TEST first** (best fresh Bob target, 0,00€ "In den Warenkorb") |
| Happydog (Shopware) | captcha + Turnstile + reCAPTCHA markers on home | **LIVE TEST before judging** |
| Belcando | Turnstile markers on home | **LIVE TEST before judging** (direct-form candidate) |
| stoffolino / HEIN / Alena Home | account + CAPTCHA | AVOID (need accounts) |

**Solver path (not yet wired):** `nopecha` CAPTCHA-solving extension (reCAPTCHA /
hCaptcha / FriendlyCaptcha / Turnstile) is present on lair404 (www-explorer) but
has NO API key in any agent env → inactive. To enable "or with solving": provision
a nopecha API key into the bridge/CamoFox env. Until then, CAPTCHA-gated sites = AVOID.

## DISCOVERY (2026-09-23, live curl via residential egress)
- Fabric (Hanna) pool EXHAUSTED: naturstoff, SOFACOMPANY, Stoffebox, Dielendealer,
  Casarista, Stoffkontor, Wohntextilien all ORDERED. Fresh candidates
  stoffquelle.de / stoffe24.de / stoffe-luise.de = curl `[000 0]` (connection-fail,
  INCONCLUSIVE — not dead, not confirmed; test in real browser). Buttinette = craft
  shop (Schnittmuster patterns, NOT free fabric samples) — wrong category.
- Pet food (Bob): Josera Katze + Hund ORDERED. Naturalisdog futterprobe = best fresh
  target (hCaptcha live-test). 8in1.de = data-sitekey (avoid).
- Lesson: static curl CAPTCHA markers are WEAK (global JS load ≠ active challenge).
  Only classify BLOCKED after a live browser sees an interactive challenge.
