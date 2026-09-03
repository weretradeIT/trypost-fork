# AGENTS.md — TryPost Fork (weretradeIT Social Media Hub)

Authoritative operating rails, workspace separation, and integration guidelines for `weretradeIT/trypost-fork`.

## Purpose & Scope

`trypost-fork` is the centralized, self-hosted Social Media Scheduling & Automation Hub for the weretradeIT ecosystem, forked from upstream [`trypostit/trypost`](https://github.com/trypostit/trypost).

It unifies:
- Visual calendar scheduling across 12 networks (LinkedIn, X/Twitter, Meta Facebook & Instagram, YouTube, TikTok, Pinterest, Threads, Bluesky, Mastodon, Telegram, Discord).
- First-class AI Copilot & remote MCP server (`/mcp/trypost`) with 26+ tools for posts, media, assets, signatures, and analytics.
- Multi-persona workspaces isolated by brand profile, tone, voice, signatures, and connected credentials.

## Upstream & Branch Ladder

- **Upstream Repository:** `https://github.com/trypostit/trypost.git`
- **Origin Repository:** `https://github.com/weretradeIT/trypost-fork.git`
- **Branch Ladder:**
  - `main`: Canonical weretrade production release.
  - `dev-ops`: Staging / release candidate branch.
  - `dev`: Active development and agent collaboration branch.
- **Sync Rule:** Regularly fetch upstream changes:
  ```bash
  git fetch upstream
  git merge upstream/main
  ```

## Persona Workspaces

| Workspace | Persona / Focus | Voice Traits | Target Networks | Primary Branding |
| :--- | :--- | :--- | :--- | :--- |
| **Bob Weber** | B2B Operations, Order Fulfillment, Logistics, EU OSS Compliance | Analytical, Pragmatic, Professional, Efficiency-driven | LinkedIn, X, Facebook | `#SupplyChain #ECommerceLogistics #weretradeIT` |
| **Hanna Thoma** | Customer Experience, Vintage Lego, Dispute Resolution, Marketplace Tips | Empathetic, Enthusiastic, Collector-Friendly, Warm | Meta (IG & FB), X, LinkedIn | `#CustomerCare #MarketplaceTips #VintageLego #weretradeIT` |
| **Corporate / BKB** | BauKlotzBude & weretradeIT Brand News, Rare Drops, Innovations | Innovative, Engaging, Authoritative | YouTube, Bluesky, Pinterest, TikTok, Company LinkedIn | `#BauKlotzBude #VintageLego #weretradeIT` |

## Mandatory Human-In-The-Loop (HITL) Guardrails

- Autonomous AI agents (Bob, Hanna, Antigravity, n8n) MUST ONLY create posts in `draft` status via the MCP server (`CreatePostTool`).
- Immediate publishing (`PublishPostTool`) requires explicit human operator confirmation.
- When an agent creates a draft via MCP, TryPost dispatches a Block Kit preview card to the designated Slack operator channel with interactive approval buttons:
  - `[ ✅ Freigeben & Einplanen ]`
  - `[ ❌ Verwerfen ]`
- Only upon operator interaction is `PublishPostTool` or status update to `publishing` / `scheduled` executed.

## Hosting & Deployment Architecture

- **Host:** `lair404` (Production runtime) / `h0menode` (Staging/Dev).
- **Public Domain:** `https://social.lair404.xyz` (or `https://post.lair404.xyz`).
- **Reverse Proxy:** Caddy with automatic Let's Encrypt TLS, guarded by Cloudflare Access SSO.
- **Docker Stack (`docker-compose.weretrade.yml`):**
  - `trypost-app`: Laravel 11/12 application (PHP 8.4-FPM, Nginx, Supervisor, Reverb WebSockets, Horizon queue worker).
  - `trypost-pgsql`: PostgreSQL 16 Alpine.
  - `trypost-redis`: Redis 7 Alpine.
- **Environment Flags:**
  - `SELF_HOSTED="true"`
  - `ALLOW_MULTIPLE_SOCIAL_ACCOUNTS="true"`
  - `TRYPOST_TARGET="production"`

## MCP Control Plane Integration

- TryPost exposes `/mcp/trypost` via SSE using Laravel Passport bearer authentication (`workspace.token:mcp`).
- Registered in `.ai/layers/workspace/mcp-catalog.json` under alias `trypost`.
- All weretrade agents can query calendar, draft posts, manage assets, and inspect post metrics natively.
