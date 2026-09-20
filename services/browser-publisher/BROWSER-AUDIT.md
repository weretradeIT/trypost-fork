# Browser Feature & Detection Audit Log

Living per-browser record of every anti-detection feature we implement and every
fingerprint signal we have measured. One section per browser engine. Add a dated
entry whenever we change identity/egress/behavior so the state is auditable and
never silently regresses.

**How to read it:** `VERIFIED` = measured live in the container (not assumed).
`GAP` = known, not yet closed. Each entry carries the date and the evidence.

Current stack: **Playwright-Chromium is the single default browser layer.**
Selenium is NOT in the stack (no binary, no grid, no container, no pip package);
the only historical reference is a commented-out example in
`compose.override.yaml.example`, removed 2026-09-20.

---

## Browser 1 — Chromium (Playwright) — DEFAULT LAYER

Identity: macOS Chrome (LinkedIn) / Windows Chrome (X). Shared factory
`src/organic/browser.js` → `createAlignedBrowser()`.

### Egress
| Date | Feature | State | Evidence |
|------|---------|-------|----------|
| 2026-09-20 | Hard fail-closed egress guardrail (`egress.js`) — every session validates outbound IP before touching a platform | VERIFIED | Hetzner AS24940 → DENY, HTTP 503 `egress_policy` |
| 2026-09-20 | Residential proxy via h0 Tailscale pproxy SOCKS5 (`socks5://100.125.10.10:1055`) | VERIFIED | Chromium egress `87.175.183.58 / AS3320 Deutsche Telekom AG / Germany` (both platforms) |
| 2026-09-20 | Egress check measures *through* the proxy (proxy-aware `fetchProxy`) | VERIFIED | guardrail reports the proxy IP, not the host IP |

### TLS / HTTP fingerprint
| Date | Feature | State | Evidence |
|------|---------|-------|----------|
| 2026-09-20 | TLS cipher ordering | VERIFIED | Chromium leads with `TLS_GREASE` + AES-GCM/CHACHA20 (real-Chrome order; the GREASE bot-tell is absent) |
| 2026-09-20 | TLS version / ALPN | VERIFIED | TLS 1.3, h2 |
| 2026-09-20 | Residual JA3/JA4 hash parity vs real Chrome | GAP (low) | Cipher list matches; exact extension-order hash not yet diffed. Candidate: real Chrome-for-Testing binary |
| 2026-09-20 | HTTP/2 SETTINGS frame fingerprint | TODO | Newer signal than TLS; probe not yet run |
| 2026-09-20 | `Sec-Fetch-*` header consistency | TODO | Verify all four present + coherent on navigation |

### Fonts
| Date | Feature | State | Evidence |
|------|---------|-------|----------|
| 2026-09-20 | Real macOS font set (Helvetica Neue, Avenir, Geneva, Menlo) bind-mounted from a real macOS (h0) | VERIFIED | `document.fonts.check` true for HN/Helvetica/Avenir/Menlo/Geneva; `fc-match sans-serif` → Helvetica Neue; Liberation removed from default |
| 2026-09-20 | Canvas glyph-metric alignment (Latin) | VERIFIED | Chromium canvas measures real macOS faces (HN 575 vs Arial 581 = distinct, correct) |
| 2026-09-20 | CJK font coverage (Noto CJK) | GAP (low) | LinkedIn/X are Latin-script; CJK detector class low-priority. `cjk/` dir empty; apt install pending |

### Client hints / headers
| Date | Feature | State | Evidence |
|------|---------|-------|----------|
| 2026-09-20 | `sec-ch-ua` scrubbed of `HeadlessChrome` (via `extraHTTPHeaders`, not CDP which suppresses hints) | VERIFIED | No `HeadlessChrome` on either platform; UA + sec-ch-ua major = 151 |
| 2026-09-20 | `sec-ch-ua-platform` per-platform (macOS/Windows) | VERIFIED | live probe |
| 2026-09-20 | `Accept-Language` German-Chrome | VERIFIED | was truncated to `de-DE` (Blink derives it from `locale` and overwrites `extraHTTPHeaders`); fixed via route-level re-assert. Full chain `de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7` now on the wire AND `navigator.languages` = 4-element chain (both correct simultaneously) |
| 2026-09-20 | **WebGL pixel + params consistency** across repeated loads | VERIFIED | vendor `Google Inc. (Apple)` / renderer `ANGLE (Apple, Apple M2 Pro, OpenGL 4.1)` / pixel readback **byte-identical across 3 loads** (variance would flag a bot) |
| 2026-09-20 | **2D Canvas consistency** across repeated loads | VERIFIED | canvas hash byte-identical across 3 loads |
| 2026-09-20 | **HTTP/2** (real Chrome uses h2, not h1.1) | VERIFIED | all navigations report `nextHopProtocol: h2` |
| 2026-09-20 | `Sec-Fetch-*` header consistency | VERIFIED | all 4 present + coherent for top-level nav (Dest=document, Mode=navigate, Site=none, User=?1) + `Upgrade-Insecure-Requests`, `Priority`, `X-Amzn-Trace-Id` |

### Navigator / in-page fingerprint (`fingerprint.js` init script)
| Date | Feature | State | Evidence |
|------|---------|-------|----------|
| 2026-09-20 | `navigator.platform` = MacIntel / Win32 | VERIFIED | live probe |
| 2026-09-20 | `navigator.plugins` (5) + `mimeTypes` (3) cross-consistent | VERIFIED | live probe |
| 2026-09-20 | `deviceMemory` 8, `hardwareConcurrency` 8, `window.chrome` present | VERIFIED | live probe |
| 2026-09-20 | WebGL1+2 vendor/renderer → Apple/ANGLE | VERIFIED | live probe |
| 2026-09-20 | Frame geometry outer>inner, screenX/Y randomized | VERIFIED | live probe |
| 2026-09-20 | Timezone Europe/Berlin, locale de-DE | VERIFIED | live probe |
| 2026-09-20 | `navigator.webdriver` → undefined | VERIFIED | live probe |
| 2026-09-20 | **AudioContext fingerprint** non-zero + stable (headless has no audio HW → all-zero flat line = bot tell) | VERIFIED | `AnalyserNode.getFloatTimeDomainData` patched; 2 loads byte-identical, nonZero=true |

### Network leaks
| Date | Feature | State | Evidence |
|------|---------|-------|----------|
| 2026-09-20 | **WebRTC host-IP leak** — STUN ICE was leaking `178.63.56.179` (Hetzner) even though page loads via residential proxy | CLOSED (flags) + RESIDUAL-LOW | `--webrtc-ip-handling-policy=disable_non_proxied` added. SOCKS5 proxy does not carry ICE so the flag alone can't reroute it; a JS `RTCPeerConnection` wrapper was rejected (detectable — breaks `instanceof`/`Symbol.hasInstance`, and hangs). Residual is LOW because LinkedIn/X do not run WebRTC in the feed-scroll / publish path (WebRTC is video/live only). If a future flow uses WebRTC, add an HTTP CONNECT proxy on h0 so ICE can route through it |

### Behavior / human simulation (`behavior.js`)
| Date | Feature | State |
|------|---------|-------|
| 2026-09-20 | `humanScroll` variable velocity + overshoot/backtrack | VERIFIED (unit) |
| 2026-09-20 | `humanMouseMove` bezier + micro-jitter | VERIFIED (unit) |
| 2026-09-20 | `humanClick` press-hold-release 50-180ms | VERIFIED (unit) |
| 2026-09-20 | Calculated misclicks (12% prob, offset, pause, re-aim, re-click) | VERIFIED (unit) |

### Remaining detection signals to close (next, in priority order)
1. **WebRTC leak** (local/host IP) — add `--webrtc-ip-handling-policy=disable_non_proxied` to Chromium. TODO
2. **AudioContext fingerprint** — patch/consistency check. TODO
3. **Keyboard/IME + plugins-vs-mimeTypes cross-check** — re-verify after fonts. TODO
4. **Sec-Fetch-* + HTTP/2 SETTINGS** — probe. TODO
5. **Canvas/WebGL pixel consistency across repeated loads** (variance = bot). TODO

---

## Browser 2 — CamoFox (camoufox-js, Firefox) — A/B SECOND LAYER

Status: **wired + verified reachable** as an opt-in second engine. Default engine
stays **Chromium** (`ORGANIC_ENGINE=chromium`); flip the env to `camofox` to A/B.
Identity: Firefox 135 fingerprint (`webdriver:false`, `h2`) — a genuinely different
engine/TLS/JA3 stack from Chromium's Chrome identity, which is the whole point of A/B.
HTTP control API on lair404 `100.100.10.10:9377` (auth `Authorization: Bearer $CAMOFOX_API_KEY`).

| Date | Feature | State |
|------|---------|-------|
| 2026-09-20 | Engine abstraction `src/organic/engine.js` (chromium default / camofox opt-in), exposed in `/health` + `/organic-status` | DONE |
| 2026-09-20 | CamoFox adapter `src/organic/camofox-engine.js` (cookie import, navigate, sync evaluate, verified scroll, session lifecycle) | DONE |
| 2026-09-20 | `warmup.js` rewritten as thin delegator to `runWarmupOnEngine()` (backward-compatible) | DONE |
| 2026-09-20 | `ORGANIC_ENGINE` / `ORGANIC_CAMOFOX_BASE_URL` / `CAMOFOX_API_KEY` wired in compose + `.env` | DONE |
| 2026-09-20 | API key + engine selftests (4) | DONE |
| 2026-09-20 | Live A/B verify: tab create/navigate/evaluate/scroll, identity = Firefox 135 / `webdriver:false` / `h2` | DONE |
| 2026-09-20 | Ledger `engine` field on camofox warmups | DONE |
| 2026-09-20 | Feed-hydration wait (marker / tall-page / growing-page detection) | DONE |
| 2026-09-20 | Native `block_webrtc` (CamoFox) — baseline for Chromium parity | available |
| 2026-09-20 | Password-login / 2FA on CamoFox (cookie-import only today) | OPEN |
| 2026-09-20 | Network-intercept **verified reactions** on CamoFox (HTTP API can't observe XHR; verified-scroll only) | OPEN |

**CRITICAL CamoFox API constraints (learned live, cost real debugging):**
1. **`/tabs/:id/evaluate` does NOT await async functions** — an `async` IIFE returns
   a Promise that serializes to `{}`. All in-page JS must be **synchronous**. Values
   are returned verbatim, but multi-property objects are safest wrapped in
   `JSON.stringify(...)` in-page and `JSON.parse`'d back (see `_evalJson`).
2. **Scrolls must be driven from the client** (Node): fire a *sync*
   `window.scrollBy(0, delta)` evaluate, `await` a human dwell in Node, then read
   `window.scrollY` back with a *sync* evaluate to verify real movement. This is
   how `scrollVerified()` honestly proves the feed scrolled.
3. **`/tabs/:id/scroll` ignores `{userId}`** — it scrolls whatever tab matches by id;
   we use in-page `scrollBy` instead for correct targeting.
4. **Cookie import is one-way** (`POST /sessions/:userId/cookies`) — no readback, no
   write-back. CamoFox persists cookies in its own profile volume, so a *valid*
   session stays valid across warmups; an *expired* one needs a fresh export from
   the Chromium side (not yet automated → login stays OPEN).

**Why A/B:** TLS/fonts are largely closed on Chromium. CamoFox is the fallback if
LinkedIn 404's again *after* warmup is live on residential egress — it patches
in-browser internals (real Firefox TLS/JA3, GPU WebGL, fonts) that JS can't fake.
**Honesty model:** CamoFox warmups record `reactions:0` by design (verified-scroll
mode) and an `engine:"camofox"` ledger tag, so a CamoFox-session account is never
mistaken for a Chromium verified-reaction account by the guardrail.

**TESTING DISCIPLINE (2026-09-20):** Do NOT run repeated live CamoFox warmups against
a real authenticated persona (e.g. `linkedin:hanna`) in a short window — that burst
of navigations/scrolls without organic browsing is the exact heuristic that 404'd Bob.
Verify the CamoFox path offline (selftest + hydration-logic unit test) and at most ONE
careful live run per persona, spaced out, once login is wired.
