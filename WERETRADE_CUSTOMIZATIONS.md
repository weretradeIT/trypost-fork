# weretradeIT Customizations for TryPost Hub

Dieses Dokument beschreibt alle Änderungen, Architekturentscheidungen und Komponenten, die in den weretradeIT-Fork von [trypostit/trypost](https://github.com/trypostit/trypost) integriert wurden.

---

## 1. Übersicht & Host-Architektur

- **Instanz**: `https://social-scheduler.lair404.xyz`
- **Host**: `lair404` (Docker Compose unter `/opt/lair404-infrastructure/services/trypost`)
- **Netzwerk**: `lair404-bridge` (verbunden mit PostgreSQL, Redis und Nginx)
- **Nginx Reverse Proxy**:
  - Web & API: `http://127.0.0.1:8330`
  - Reverb WebSocket: `http://127.0.0.1:8331` (geroutet über `/app`)

---

## 2. Centralized weretrade SSO & Auto-Login

### AuthLion (`core-lion`) Handoff
- **Worker**: `weretradeIT/authLion/backend/worker.ts`
- **Shared Secret**: `yMMUwgY3rmUKv8a18/bToDpJZzXzPMmcaDAGCeS142NWZ0yUIqq2+ts7BfA5tMiJ` (entspricht `LOGIN_JWT_SECRET` in TryPost `.env` und Vault `secret/lair404/trypost`).
- **Google OAuth Flow**: Nach erfolgreichem Login auf `login.weretrade.com` (z. B. via `weretradeit@gmail.com`) leitet AuthLion mit `?token={jwt}&session={jwt}` an `https://social-scheduler.lair404.xyz/auth/sso/callback` weiter.

### TryPost Middleware & Service
- **Middleware**: `app/Http/Middleware/WeretradeSsoMiddleware.php`
  - Registriert in `bootstrap/app.php` im `web`-Stack.
  - Prüft eingehende Requests auf `CF_Authorization`, `token` und `session` (Cookies oder URL-Query-Parameter).
  - Erkennt automatisch SSO-Tokens und authentifiziert den Nutzer vor dem Erreichen geschützter Routen.
- **Service**: `app/Services/WeretradeSsoService.php`
  - Validiert die HS256-JWT-Signatur.
  - Automatische Benutzerbereitstellung (`findOrCreateUser`):
    - Ordnet neue Benutzer automatisch der primären weretrade Account-ID (`01a06910-bbd6-7183-8023-e8d3701a9cc0`) zu.
    - Fügt den Benutzer als `admin` zu allen 4 Personas/Workspaces hinzu.
    - Setzt `current_workspace_id` auf den Standard-Workspace (verhindert 403-Fehler bei `/workspaces/create`).
- **Frontend**:
  - `resources/js/components/auth/SocialLogin.vue`: Ersetzt Standard-GitHub/Google-Buttons durch einen prominenten "Mit weretrade SSO anmelden"-Button, der an `https://login.weretrade.com/api/auth/sso` delegiert.

---

## 3. Multi-Persona Workspace Architektur

TryPost wurde mit 4 vordefinierten Workspaces für weretradeIT konfiguriert:

| Workspace | UUID | Persona-Fokus & Brand Voice |
| :--- | :--- | :--- |
| **Bob Weber** | `01a06910-c0eb-711f-8162-31af2836eb45` | B2B Operations, Logistik, EU-OSS, Inventar (`#1E40AF`, analytisch & pragmatisch) |
| **Hanna Thoma** | `01a06910-c25a-7393-8218-23a624c7c9c4` | CX, Sammler-Support, Lego-Vintage, Vinted/Kleinanzeigen (`#7C3AED`, warm & empathisch) |
| **weretradeIT Corporate & BKB** | `01a06910-c332-7080-88da-04b44569f711` | BauKlotzBude, E-Commerce News, Plattform-Updates (`#059669`, autoritativ & innovativ) |
| **weretrade Admin** | `01a06910-c09a-7101-9192-48a99b85b272` | Übergreifende Administration & Steuerung |

### Bootstrap Command:
```bash
php artisan weretrade:setup
```
Erstellt die Workspaces, Brand-Informationen, Markenfarben und generiert MCP-OAuth-Tokens mit Scope `mcp:use`.

---

## 4. Social Media Accounts (LinkedIn & X Direct Injection)

Da bei einer Self-Hosted-Instanz ohne eigene Developer-Portal-Freigaben für X/LinkedIn OAuth 2.0 PKCE fehlschlägt, wurde ein direkter Injektions-Mechanismus implementiert:

### Artisan Command:
```bash
php artisan weretrade:attach-social-accounts
```
- Hinterlegt in der Tabelle `social_accounts` für jeden Workspace die passenden X- und LinkedIn-Accounts mit verifizierten Handles (`bob_w1408`, `bob-wt-ab1559426`, `weretradeHanna`, `hanna-wt-463566426`, `weretrade`).
- Hinterlegt die verschlüsselten Auth-Tokens und Session-Cookies aus `credentials.enc` in `access_token` und `meta`.
- Setzt Status direkt auf `Status::Connected` (`connected`) und `is_active = true`.

---

## 5. Reverb WebSocket Fix

- **Problem**: Das Standard-Bundle hatte `localhost:8080` für WebSockets hartkodiert.
- **Fix**:
  - `resources/js/echo.ts`: Dynamische Erkennung via `window.location.hostname` und SSL-Port `443` mit `forceTLS: true`.
  - Nginx auf `lair404`: Routet `location /app { proxy_pass http://127.0.0.1:8331; ... }`.
  - Live-Bundle `app-Jms6KH3E.js` gepatcht für unterbrechungsfreien Echtzeitbetrieb im Kalender.

---

## 6. UI & Sidebar Bereinigung

- **Entfernte Promotion-Links**:
  - `Earn 30% referral` (`https://affiliates.trypost.it/`)
  - `Discord community` (`https://trypost.it/discord`)
  - `Documentation` (`https://docs.trypost.it`)
- **Quellcode**: Aus `resources/js/components/AppSidebar.vue` wurden `bottomNavItems`, `NavSupport` und die Gruppe `sidebar.groups.others` vollständig entfernt.
- **Produktions-Bundle**: In `AppLayout-CMQwJcZM.js` wurde das Rendering des `OTHERS`-Abschnitts neutralisiert.

---

## 7. Slack HITL Post Approval Integration

- **Job**: `app/Jobs/Weretrade/DispatchSlackHitlApproval.php`
- Sendet vor Veröffentlichung interaktive Slack Block Kit Nachrichten an den zuständigen Kontrollkanal.
- Ermöglicht Review, Freigabe oder Ablehnung ("Genehmigen" / "Überarbeiten") durch Operatoren, bevor Posts live gehen.

---

## 8. Headless Browser Publishing Bridge (Option B — Playwright)

Für Accounts und Personas (wie Hanna Thoma und Bob Weber), die ohne teure Twitter API Tiers (z. B. Basic 100\$/Monat) oder restriktive LinkedIn Developer Verifications betrieben werden:

- **Architektur**: Ein lokaler Node.js/Playwright Microservice (`trypost-browser-publisher`) auf Port 3400 im Docker-Netzwerk `database_net`.
- **Publisher Bridge**: `app/Services/Social/BrowserBridge/BrowserBridgePublisher.php`.
- **Auto-Fallback**: `XPublisher` und `AbstractLinkedInPublisher` erkennen automatisch, wenn ein Account mit `session_*` Tokens eingehängt ist oder keine `client_id` hinterlegt ist, und delegieren die Veröffentlichung transparent an den Headless Browser.
- **Session Injection**:
  - Für **X (Twitter)**: Authentifizierung via `auth_token` und `ct0` Cookies direkt im Browsercontext, Absenden über die Web-UI (`compose/post`), Abfangen der GraphQL-Antwort (`CreateTweet`) zur Rückmeldung der exakten Tweet-ID und URL.
  - Für **LinkedIn**: Authentifizierung via `li_at` Cookie, Posting über die Web-UI, Abfangen der Post-URN zur Verknüpfung im Dashboard.
- **Artisan Test-Command**: `php artisan weretrade:test-browser-publish {platform} {username} [--text=...] [--dry-run]`.

---

## 9. Patch & Upstream Update-Workflow

Um zukünftige Updates von `upstream/main` (`trypostit/trypost`) einzuspielen:

1. **Patch erstellen** (bereits automatisiert unter `patches/weretrade-trypost-customizations.patch`):
   ```bash
   git diff upstream/main dev > patches/weretrade-trypost-customizations.patch
   ```

2. **Upstream rebasen / mergen**:
   ```bash
   git checkout dev
   git fetch upstream
   git merge upstream/main
   # Falls Konflikte auftreten:
   git checkout -b update/upstream-sync
   git apply --reject patches/weretrade-trypost-customizations.patch
   ```

3. **Frontend & Container Build**:
   ```bash
   npm run build
   docker compose -f docker-compose.weretrade.yml build
   ```
