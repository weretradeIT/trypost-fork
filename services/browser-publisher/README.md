# TryPost Browser Publisher Bridge

Headless-Browser-Publishing-Bridge für die TryPost-Instanz: nimmt
`POST /publish`-Requests von Laravel entgegen und publiziert über echte
Browser-Sessions (Playwright/Chromium) bei X und LinkedIn.

Seit der **Organic Activity Engine** (2026-09-19, nach dem
LinkedIn-Anti-Abuse-Vorfall des Bob-Kontos am 18.09.) zusätzlich:

- Automatische organische Warmup-Sessions (Feed-Scrollen + Reaktionen)
- Pre-Publish-Guardrail (kein Post ohne frische organische Aktivität)
- Aktivitäts-Ledger (persistenter Proof-of-Life je Konto)
- **Residential-IP-Egress-Guardrail** (HARD, fail-closed)
- **Fingerprint-Ausrichtung** (UA/Sec-Ch-Ua, Platform, Plugins, WebGL, Timezone)
- **Berechnete Fehlklicks** (menschliche Imperfektion)
- HTTP-Rate-Limits, Input-Validierung, Timing-sichere Auth

## Endpunkte

| Methode | Pfad            | Auth     | Rate-Limit (Burst/Stunde) | Zweck                                          |
| ------- | --------------- | -------- | ------------------------- | ---------------------------------------------- |
| GET     | `/health`       | nein¹    | –                         | Liveness + minimale Organic-Engine-Infos       |
| GET     | `/organic-status` | ja | 20 / 100                | Guard-Status je Konto oder Snapshot            |
| POST    | `/warmup`       | ja       | 3 / 8                     | Manuelle organische Session für ein Konto      |
| POST    | `/publish`      | ja       | 5 / 20                    | Posting (nach Guardrail-Prüfung)               |

¹ `/health` ist unauthentifiziert, aber nur auf `127.0.0.1` gebunden
(Host-Port `8332`) — es liefert **keine** Konto-Details mehr, nur
`enabled`, `guardrail_enabled`, Anzahl verwalteter Konten.

Auth: `Authorization: Bearer $TRYPOST_BROWSER_BRIDGE_SECRET`.
Vergleich ist timing-safe (SHA-256 + `crypto.timingSafeEqual`).

## Organic Activity Engine

Ortsbestimmend: alle Persona-Konten (Hanna, Bob) fließen durch eine einzige
Bridge. Die Engine sitzt hier, nicht in den Agenten — ein einziger Choke-Point
deckt alle 4 Kontos (LinkedIn/X × Hanna/Bob).

```
services/browser-publisher/src/
├── server.js                  Express + Auth + Rate-Limits + Validierung
├── credentials.js             Env → Cred-Resolver (Personas)
├── publishers/                LinkedIn/X Publish-Logik (nutzt createAlignedBrowser)
└── organic/
    ├── config.js              ORGANIC_* Env-Konfiguration (Defaults)
    ├── accounts.js            Persona-Erkennung (hanna/bob vs. corporate)
    ├── ledger.js              Aktivitäts-Ledger (atomares JSON) + Guard-Logik
    ├── behavior.js            Menschliches Verhalten (Pausen, Scrollen, Mäusebewegung, Fehlklicks)
    ├── browser.js             GEMEINSAME Browser-Identitäts-Factory (Warmup + Publish)
    ├── fingerprint.js         In-Page-Fingerprint-Init-Script (navigator, Plugins, WebGL, Frame)
    ├── egress.js              HARD Residential-IP-Guardrail (fail-closed, ifconfig.co)
    ├── session.js             Warmup-Session (Cookies, Login, 2FA) über browser.js
    ├── linkedin.js            LinkedIn Feed-Scroll + Likes (API-verifiziert)
    ├── x.js                   X Timeline-Scroll + Likes (API-verifiziert)
    ├── warmup.js              Eine organische Session für ein Konto
    ├── scheduler.js           Warmup-Planer (Tick, Quiet Hours, Backoff, In-Flight-Lock)
    ├── guardrail.js           Pre-Publish-Prüfung
    ├── rate-limiter.js        Sliding-Window-Limiter (Burst + stündlich)
    ├── fingerprint-probe.js   Audit-Probe: alle Header + In-Page-Signale + Egress-IP
    ├── fingerprint-verify.js  Verifikation: zeigt, was die Factory WIRKLICH sendet
    └── selftest.js            Offline-Unit-Tests (31 Fälle)
```

### Funktionsweise

1. **Scheduler** (Tick alle 5 min ± Jitter): Jedes Konto bekommt alle
   3–7 h eine organische Session — nie in Quiet Hours (23–6 Uhr Europe/Berlin).
   Fehler → Backoff 1–3 h. Passwort-Logins max. 1×/Tag/Konto (Budget im Ledger).
2. **Organische Session**: gemeinsamer Browser-Fingerprint (identisch für
   Publish und Warmup), Cookies aus `/app/cookies/{persona}.json`,
   Authwall- und Challenge-Handling, Feed-Scrollen (3–6 Schritte,
   menschliche Pausen), optional 1–2 Reaktionen (API-verifiziert: nur gezählt,
   wenn LinkedIns Voyager-/X-API den Like bestätigt hat).
3. **Ledger** (`/app/cookies/organic-ledger.json`, `0600`): jede Session,
   Reaktion, jeder Login und jede Guard-Entscheidung mit Zeitstempel.
   Atomare Schreibweise (tmp + rename).
4. **Guardrail** vor jedem `/publish` für Persona-Konten:
   - Scroll-Session ≤ 24 h alt **und**
   - verifizierte Reaktion ≤ 72 h alt (Fallback: ≥3 frische Scroll-Sessions
     ohne verifizierbare Reaktion → degradiert auf Scroll-only, damit
     Selector-Drift das Publizieren nicht dauerhaft einfriert).
   - Blockiert → `HTTP 425`, `category: content_policy`,
     `retry_after_minutes` (aus dem nächsten geplanten Warmup).
   - Corporate-Konten und unbekannte Plattformen werden nicht geprüft
     (echte Menschen, kein synthetisches Persona-Problem).

### Rate-Limits (Sicherheit)

Sliding Window, in-memory, pro `IP + Token-Suffix`:

| Endpunkt   | Burst          | Stündlich      |
| ---------- | -------------- | -------------- |
| `/publish` | 5 / 60 s       | 20             |
| `/warmup`  | 3 / 60 s       | 8              |
| `/organic-status` | 20 / 60 s | 100          |

Überschreitung → `HTTP 429` mit `Retry-After`. Zusätzlich:

- **In-Flight-Lock** pro Konto: ein zweiter Warmup für dasselbe Konto wird
  abgelehnt (`busy: true`), egal ob vom Scheduler oder manuell — verhindert
   doppelte Browser auf demselben Cookie-Jar.
- **Body-Limit**: 1 MB JSON (früher 10 MB).
- **Input-Validierung**: `username` `[a-z0-9._-]{1,64}`; `text` ≤ 280 (X) /
  3000 (LinkedIn); `media` ≤ 4 Items.
- **BRIDGE_SECRET zwingend**: ohne Secret verweigert die Bridge den Start
  (503), statt offen zu lauschen.
- **Keine Secrets in Logs**: Credentials werden nie geloggt; `/health` ohne
  Auth liefert nur Zählwerte.

## Konfiguration (Env)

Alle `ORGANIC_*` sind optional — Defaults sind sicher.

| Variable                          | Default        | Bedeutung                                        |
| --------------------------------- | -------------- | ------------------------------------------------ |
| `ORGANIC_WARMUP_ENABLED`          | `true`         | Scheduler an/aus                                 |
| `ORGANIC_WARMUP_TICK_MINUTES`     | `5`            | Scheduler-Tick                                   |
| `ORGANIC_WARMUP_MIN/MAX_INTERVAL_H` | `3` / `7`    | Abstand der Sessions pro Konto (zufällig dazw.)  |
| `ORGANIC_WARMUP_TIMEZONE`         | `Europe/Berlin`| für Quiet Hours                                  |
| `ORGANIC_WARMUP_QUIET_START/END`  | `23` / `6`     | keine Sessions in diesem Fenster                 |
| `ORGANIC_WARMUP_MAX_LOGINS_PER_DAY` | `1`          | Passwort-Login-Budget je Konto/Tag               |
| `ORGANIC_WARMUP_SCROLL_MIN/MAX`   | `3` / `6`      | Scroll-Schritte je Session                       |
| `ORGANIC_WARMUP_REACTION_PROB`    | `0.6`          | Wahrscheinlichkeit einer Reaktionsphase          |
| `ORGANIC_WARMUP_MAX_REACTIONS_PER_DAY` | `3`       | Reaktions-Budget je Konto/Tag                    |
| `ORGANIC_GUARDRAIL_ENABLED`       | `true`         | Pre-Publish-Prüfung                              |
| `ORGANIC_GUARDRAIL_SCROLL_MAX_AGE_H` | `24`       | Scroll-Session darf max. so alt sein             |
| `ORGANIC_GUARDRAIL_REQUIRE_REACTION` | `true`      | zusätzlich Reaktion verlangen                    |
| `ORGANIC_GUARDRAIL_REACTION_MAX_AGE_H` | `72`     | Reaktions-Fenster                                |
| `ORGANIC_GUARDRAIL_PERSONAS`      | `hanna,bob`    | geprüfte Personas (Comma-Separat)                |
| `ORGANIC_LEDGER_PATH`             | `/app/cookies/organic-ledger.json` | Ledger-Pfad                 |
| `ORGANIC_EGRESS_ENFORCE`          | `true`         | HARD Egress-Guardrail an/aus (fail-closed) |
| `ORGANIC_EGRESS_ALLOWLIST`        | *(leer)*       | Erlaubte IPs/CIDR (Comma-Separat) — gewinnt über DC-Keywords |
| `ORGANIC_EGRESS_DC_KEYWORDS`      | 15 DC-Begriffe | Org/AS-Muster, die blockieren (hetzner, aws, google, …) |
| `ORGANIC_EGRESS_CACHE_MINUTES`    | `60`           | TTL des Egress-Verdict-Caches (kein API-Spam) |
| `ORGANIC_BROWSER_PROXY`           | *(leer)*       | Proxy-Server für Browser (z. B. `socks5://…`) — Residential/Tailscale-Exit |
| `ORGANIC_MISCCLICK_PROB`          | `0.12`         | Wahrscheinlichkeit eines berechneten Fehlklicks pro Klick |
| `ORGANIC_MISCCLICK_MAX_OFFSET_PX` | `120`          | Max. Fehlklick-Offset vom Ziel |
| `ORGANIC_CHROME_MAJOR`            | `151`          | Chrome-Major für UA + Client Hints (Container-Build) |
| `RATE_LIMIT_PUBLISH_BURST/HOURLY` | `5` / `20`     | Publish-Limit                                    |
| `RATE_LIMIT_WARMUP_BURST/HOURLY`  | `3` / `8`      | Warmup-Limit                                     |
| `RATE_LIMIT_STATUS_BURST/HOURLY`  | `20` / `100`   | Status-Limit                                     |

## Fingerprint- & Header-Ausrichtung

**Ein Identitäts-Choke-Point:** Warmup- und Publish-Sessions starten ihre
Browser ausschließlich über `createAlignedBrowser()` (`organic/browser.js`).
Damit sehen LinkedIn/X exakt dasselbe „Browser" pro Konto — der
Windows-Chrome-131/macOS-Chrome-128-Bruch (frühere Publisher-Own-Launches)
ist beseitigt.

Pro Plattform eine konsistente Identität (Major = Container-Chromium-Build):

| Signal                    | LinkedIn (Hanna/Bob)   | X (Hanna/Bob)            |
| ------------------------- | ---------------------- | ------------------------ |
| `User-Agent`              | macOS Chrome 151       | Windows Chrome 151       |
| `Sec-Ch-Ua`               | `"Chromium";151, "Not_A Brand";24, "Google Chrome";151` (beide) |
| `Sec-Ch-Ua-Platform`      | `"macOS"`              | `"Windows"`              |
| `navigator.platform`      | `MacIntel`             | `Win32`                  |
| Viewport                  | 1440×900               | 1920×1080                |
| Timezone / Locale         | `Europe/Berlin` / `de-DE` (beide) |

**Client Hints sind der wichtigste Headless-Tell.** Headless-Chromium
stempelt `HeadlessChrome` in `sec-ch-ua`. Im Container live getestet:
CDP-`setUserAgentOverride` mit `secChUa` *unterdrückt* die gesamte
Hint-Gruppe (Header verschwindet — noch auffälliger). Die wirksame
Methode: `context.extraHTTPHeaders` — ersetzt `sec-ch-ua` sauber auf
**jedem** Request, gesetzt bevor eine Seite existiert (kein
First-Request-Leak, kein CDP-Race). Gesendet werden exakt die 3
Header, die dieses Chromium-Build nativ sendet (`sec-ch-ua`,
`-mobile`, `-platform`) — kein erfundenes 4.

**In-Page-Signale** (per `addInitScript`, `organic/fingerprint.js`):
`navigator.webdriver=undefined`, `window.chrome` vorhanden, 5 PDF-Plugins
+ 3 Mime-Types (kruzreferenziert konsistent), `deviceMemory=8`,
`hardwareConcurrency=8`, `languages=[de-DE,de,en-US,en]`, WebGL1+WebGL2
vendor/renderer → Apple/ANGLE, Browser-Frame-Geometrie
(outer>inner, screenX/Y plausibel) statt `outer==inner`/`screenX=0`.

**Verifikation:** `node /app/src/organic/fingerprint-verify.js
{linkedin|x}` zeigt die tatsächlich ausgehenden Header + In-Page-Signale;
`fingerprint-probe.js` das vollständige Audit inkl. Egress-IP/AS.

## Egress-Guardrail (HARD, fail-closed)

Jede Browser-Session (Warmup **und** Publish) prüft VOR dem Plattform-Zugriff
die ausgehende IP (`organic/egress.js`, `ifconfig.co/json`, Cache-TTL
`ORGANIC_EGRESS_CACHE_MINUTES`):

- Datencenter-AS/Org (Keyword-Treffer, z. B. `hetzner`) → **Block** mit
  `EgressPolicyError`.
- `ORGANIC_EGRESS_ALLOWLIST` (IP/CIDR) gewinnt über die Keyword-Prüfung.
- Verdict-Cache: ein Verdict pro TTL, kein API-Spam.

Laravel-Integration: Bridge antwortet `HTTP 503` +
`category: egress_policy` + `permanent: true` → `ErrorCategory::EgressPolicy`
→ `isResumable() = false` → **kein Retry-Loop**, der Fehler ist im
Post-Status sichtbar und erfordert eine Infrastruktur-Entscheidung
(Proxy setzen oder Allowlist erweitern). Derzeit: lair404 egressed über
Hetzner-AS24940 → **alle Sessions blockiert**, bis `ORGANIC_BROWSER_PROXY`
auf einen Residential/Tailscale-Exit zeigt oder die Hetzner-IP
allowlistet (zweckentfremdet).

## Betrieb (lair404)

Bind-Mount: `/opt/lair404-infrastructure/services/trypost/publisher/src` →
`/app/src` — Quelländerungen wirken nach `docker compose restart
browser-publisher` ohne Rebuild. Container ist nur per Tailscale/Docker-Netz
erreichbar; Host-Port `127.0.0.1:8332` (localhost-only).

```bash
# Health (ohne Auth, nur Liveness)
curl -s http://127.0.0.1:8332/health

# Guard-Status eines Kontos
curl -s "http://127.0.0.1:8332/organic-status?platform=linkedin&username=hanna-wt-463566426" \
  -H "Authorization: Bearer $TRYPOST_BROWSER_BRIDGE_SECRET"

# Manueller Warmup (Blockiert, wenn das Konto gerade in einer Session ist)
curl -s -X POST http://127.0.0.1:8332/warmup \
  -H "Authorization: Bearer $SECRET" -H "Content-Type: application/json" \
  -d '{"platform":"linkedin","username":"hanna-wt-463566426"}'

# Ledger inspizieren (0600 root; über docker)
docker exec trypost-browser-publisher cat /app/cookies/organic-ledger.json

# Selftest im Container (ohne Browser/Netzwerk)
docker exec trypost-browser-publisher node /app/src/organic/selftest.js
```

### Fehler-Runbuch

| Symptom | Ursache / Gegenmaßnahme |
| ------- | ------------------------ |
| `ORGANIC_ACTIVITY_REQUIRED` (425) | Konto kalt. Normal: nächster Scheduler-Tick wärmt es. Bei Eile: manuellen Warmup (oben). |
| Warmup `not authenticated`, wiederholt | `li_at`/`auth_token`-Token tot. Ein Login-Tag wird vom Budget abgezogen; danach manuell frische Token in der Vault setzen (`LINKEDIN_*_LI_AT`, `X_*_AUTH_TOKEN`) und `.env` neu syncen. |
| `Warmup … already in progress` | Session läuft noch (25–90 s). Nicht stören. |
| `Rate limit exceeded` (429) | Legit. `Retry-After` beachten. Limits sind bewusst klein: jedes Request startet Chromium. |
| Reaktionen dauerhaft 0 | Selector-Drift (Platform-Redesign). Nach 3 frischen Scroll-Sessions degradiert der Guard auf Scroll-only (Log: `selector drift`). Selectors in `organic/linkedin.js` / `organic/x.js` aktualisieren. |
| Bob-`xPasswordLogin` schlägt fehl | X will im Login-Flow zuerst den Handle (`X_BOB_USERNAME`), dann E-Mail/Passwort. Fehlender Handle → `credentials.js` liefert keinen `username`-Wert; Env ergänzen. |
| `EGRESS_POLICY` (503, `egress_policy`) | lair404 egressed aus einem Datencenter-AS (Hetzner). Dauerhaft, kein Retry. Entweder `ORGANIC_BROWSER_PROXY` auf Residential/Tailscale-Exit setzen, oder die konkrete IP in `ORGANIC_EGRESS_ALLOWLIST` tragen (zweckentfremdet). Verdict-Cache: `ORGANIC_EGRESS_CACHE_MINUTES`. |

## Sicherheitsmodell

- **Auth**: Bearer-Secret, timing-safe Vergleich, kein Start ohne Secret.
- **Reichweite**: nur `127.0.0.1:8332` am Host; im Docker-Netz als
  `trypost-browser-publisher:3400`. Keine öffentliche Route.
- **Raten**: pro Endpunkt und pro IP+Token — ein kompromittiertes Secret
  kann die Bridge nicht als DDoS-/Login-Burner gegen LinkedIn/X nutzen.
- **Identität**: Warmup und Publish teilen Fingerprint + Cookie-Jar
  (`organic/session.js`), damit kein Session-Drift auffällt.
- **Daten**: Ledger und Cookies liegen auf dem Bind-Mount unter `0600`;
  keine Secrets in Logs; `/health` liefert keine Kontodaten.
- **Anti-Fraud-Durchsatz**: max. ~4 Konten × 1 Session/3–7 h + Publish-Limit
  → deutlich unter platformseitigen Verdachts-Schwellen.

## Tests

```bash
node src/organic/selftest.js   # 31 Fälle: Personas, Ledger, Guard, Quiet Hours, Egress, Misclick, Client-Hints
```

Live-Validierung (im Container): Guard-Block eines kalten Kontos (425),
Guard-Pass eines warmen Kontos, Warmup-Session mit echten Scrolls
(`scrolls>0`), Rate-Limit-429 nach Burst-Erschöpfung. Fingerprint:
`node /app/src/organic/fingerprint-verify.js linkedin|x` — zeigt die
tatsächlich ausgehenden Header (keine `HeadlessChrome` in `sec-ch-ua`) +
In-Page-Signale.
