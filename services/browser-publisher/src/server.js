import express from 'express';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
import { publishToX } from './publishers/x-publisher.js';
import { publishToLinkedIn } from './publishers/linkedin-publisher.js';
import { ORGANIC_CONFIG } from './organic/config.js';
import { activeEngine } from './organic/engine.js';
import { assertOrganicBeforePublish, guardForAccount } from './organic/guardrail.js';
import { initScheduler, warmStatus, warmupNow, activeWarmupKeys } from './organic/scheduler.js';
import { publishLimiter, warmupLimiter, statusLimiter } from './organic/rate-limiter.js';
import { lastEgressVerdict } from './organic/egress.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3400;
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || '';

// --- Input validation ------------------------------------------------------
const USERNAME_RE = /^[a-z0-9._-]{1,64}$/i;
const MAX_TEXT_LEN = { x: 280, linkedin: 3000, 'linkedin-page': 3000 };
const MAX_MEDIA_PER_POST = 4;

function validatePublishBody(body) {
  const { platform, username, text, media = [] } = body || {};
  const problems = [];
  if (!platform || typeof platform !== 'string') problems.push('platform is required');
  if (!username || typeof username !== 'string' || !USERNAME_RE.test(username)) {
    problems.push('username must be 1-64 chars of [a-z0-9._-]');
  }
  if (!text || typeof text !== 'string' || text.trim().length === 0) problems.push('text is required');
  const normPlatform = String(platform || '').toLowerCase();
  if (typeof text === 'string' && MAX_TEXT_LEN[normPlatform] && text.length > MAX_TEXT_LEN[normPlatform]) {
    problems.push(`text exceeds ${MAX_TEXT_LEN[normPlatform]} chars for ${normPlatform}`);
  }
  if (!Array.isArray(media) || media.length > MAX_MEDIA_PER_POST) {
    problems.push(`media must be an array of at most ${MAX_MEDIA_PER_POST} items`);
  }
  return problems;
}

// --- Rate limit middleware factory -----------------------------------------
function rateLimit(limiter, scope) {
  return (req, res, next) => {
    // Key by IP + token so one token can't be rotated to dodge the limit.
    const key = `${req.ip}::${(req.headers.authorization || '').slice(-12)}`;
    const verdict = limiter.check(key);
    res.setHeader('X-RateLimit-Remaining', verdict.allowed ? verdict.remaining[scope] ?? 0 : 0);
    if (!verdict.allowed) {
      res.setHeader('Retry-After', String(verdict.retryAfterSeconds));
      return res.status(429).json({
        success: false,
        error: `Rate limit exceeded (${verdict.scope} window: ${scope})`,
        category: 'platform_unavailable',
        retry_after_seconds: verdict.retryAfterSeconds,
      });
    }
    next();
  };
}

// --- Auth middleware (timing-safe compare) ----------------------------------
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  if (!BRIDGE_SECRET) {
    // Refuse to run without a secret: the bridge carries account credentials.
    return res.status(503).json({ success: false, error: 'Bridge not configured (missing BRIDGE_SECRET)' });
  }
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'Unauthorized: missing bearer token' });
  }
  const token = authHeader.slice(7).trim();
  const a = crypto.createHash('sha256').update(token).digest();
  const b = crypto.createHash('sha256').update(BRIDGE_SECRET).digest();
  if (!crypto.timingSafeEqual(a, b)) {
    return res.status(403).json({ success: false, error: 'Forbidden: invalid bridge token' });
  }
  next();
});

// --- Routes ------------------------------------------------------------------
app.get('/health', (req, res) => {
  // Deliberately minimal: this endpoint is unauthenticated (local bind only).
  res.json({
    status: 'ok',
    service: 'trypost-browser-publisher',
    supported_platforms: ['x', 'linkedin', 'linkedin-page'],
    organic_activity: ORGANIC_CONFIG.enabled
      ? {
          enabled: true,
          guardrail_enabled: ORGANIC_CONFIG.guardrailEnabled,
          egress_enforced: ORGANIC_CONFIG.egressEnforce,
          egress_ok: lastEgressVerdict()?.ok ?? null,
          engine: activeEngine(),
          managed_accounts: warmStatus().accounts ? Object.keys(warmStatus().accounts).length : 0,
        }
      : { enabled: false },
    timestamp: new Date().toISOString(),
  });
});

app.get('/organic-status', rateLimit(statusLimiter, 'burst'), (req, res) => {
  const { platform, username } = req.query;
  if (platform && username) {
    return res.json({ success: true, guard: guardForAccount(platform, String(username)) });
  }
  return res.json({ success: true, egress: lastEgressVerdict(), ...warmStatus() });
});

app.post('/warmup', rateLimit(warmupLimiter, 'burst'), async (req, res) => {
  const { platform, username } = req.body || {};
  if (!platform || !username) {
    return res.status(400).json({ success: false, error: 'platform and username are required' });
  }
  try {
    const result = await warmupNow(platform, String(username));
    return res.json({ success: result.ok, ...result });
  } catch (err) {
    console.error(`[BridgeServer] Manual warmup failed: ${err.message}`);
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/publish', rateLimit(publishLimiter, 'burst'), async (req, res) => {
  const { platform, username, text, media = [] } = req.body || {};

  const problems = validatePublishBody(req.body);
  if (problems.length) {
    return res.status(400).json({ success: false, error: `Invalid request: ${problems.join('; ')}` });
  }

  console.log(`[BridgeServer] Received publish request: platform=${platform}, user=${username}, len=${String(text).length}`);

  // ---- Organic activity guardrail (persona accounts only) ---------------
  const guard = assertOrganicBeforePublish(platform, username);
  if (!guard.allowed) {
    console.warn(`[BridgeServer] Guardrail BLOCKED publish for ${platform}/${username}: ${guard.reason}`);
    return res.status(425).json({
      success: false,
      error: guard.reason,
      category: 'content_policy',
      retry_after_minutes: guard.retryAfterMinutes,
      guard: {
        account_key: guard.account?.accountKey,
        scroll_required_within_h: ORGANIC_CONFIG.maxScrollAgeHours,
      },
    });
  }
  if (guard.account?.managed) {
    console.log(`[BridgeServer] Guardrail passed for ${guard.account.accountKey}: ${guard.reason}`);
  }

  try {
    let result;
    const normPlatform = String(platform).toLowerCase();

    if (normPlatform === 'x') {
      result = await publishToX({ username, text, media });
    } else if (normPlatform === 'linkedin' || normPlatform === 'linkedin-page') {
      result = await publishToLinkedIn({ platform: normPlatform, username, text, media });
    } else {
      return res.status(400).json({
        success: false,
        error: `Platform '${platform}' is not supported by browser publisher bridge`,
      });
    }

    return res.json(result);
  } catch (err) {
    console.error(`[BridgeServer] Publish failed: ${err.message}`);
    // Hard egress-policy refusal: no platform traffic may leave from a
    // datacenter IP. This is a permanent infra failure (needs proxy/IP
    // config), NOT retryable — surface it distinctly to Laravel.
    if (err.name === 'EgressPolicyError' || err.category === 'egress_policy') {
      return res.status(503).json({
        success: false,
        error: err.message,
        category: 'egress_policy',
        permanent: true,
      });
    }
    return res.status(500).json({
      success: false,
      error: err.message,
      category: 'unknown',
    });
  }
});

// Unknown paths: never echo the route (avoid information disclosure).
app.use((req, res) => res.status(404).json({ success: false, error: 'Not found' }));

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[trypost-browser-publisher] Server listening on http://0.0.0.0:${PORT}`);
  // Start the organic warmup scheduler (no-op when disabled).
  try {
    initScheduler();
  } catch (err) {
    console.error(`[trypost-browser-publisher] Organic scheduler failed to start: ${err.message}`);
  }
});

// --- Graceful shutdown: never kill a warmup browser mid-flight --------------
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  const active = activeWarmupKeys();
  console.log(
    `[trypost-browser-publisher] ${signal} received; active warmups: ${active.length ? active.join(', ') : 'none'}. Closing in 5s…`
  );
  setTimeout(() => {
    console.log('[trypost-browser-publisher] Forcing exit (in-flight browsers are owned by child processes; Playwright kills them on process exit).');
    process.exit(0);
  }, 5000).unref();
  server.close(() => process.exit(0));
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
