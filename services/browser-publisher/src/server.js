import express from 'express';
import dotenv from 'dotenv';
import { publishToX } from './publishers/x-publisher.js';
import { publishToLinkedIn } from './publishers/linkedin-publisher.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3400;
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || '';

app.use(express.json({ limit: '10mb' }));

// Secret verification middleware
app.use((req, res, next) => {
  if (req.path === '/health') return next();

  if (BRIDGE_SECRET) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Unauthorized: missing bearer token' });
    }
    const token = authHeader.slice(7).trim();
    if (token !== BRIDGE_SECRET) {
      return res.status(403).json({ success: false, error: 'Forbidden: invalid bridge token' });
    }
  }
  next();
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'trypost-browser-publisher',
    supported_platforms: ['x', 'linkedin', 'linkedin-page'],
    configured_credentials: {
      x_hanna: Boolean(process.env.X_HANNA_AUTH_TOKEN || process.env.X_AUTH_TOKEN),
      x_bob: Boolean(process.env.X_BOB_PASSWORD || process.env.X_PASSWORD),
      linkedin_hanna: Boolean(process.env.LINKEDIN_HANNA_LI_AT || process.env.LINKEDIN_LI_AT),
      linkedin_bob: Boolean(process.env.LINKEDIN_BOB_PASSWORD || process.env.LINKEDIN_PASSWORD),
    },
    timestamp: new Date().toISOString(),
  });
});

app.post('/publish', async (req, res) => {
  const { platform, username, text, media = [] } = req.body;

  console.log(`[BridgeServer] Received publish request: platform=${platform}, user=${username}`);

  if (!platform || !text) {
    return res.status(400).json({
      success: false,
      error: 'Missing required fields: platform and text are required',
    });
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
    console.error(`[BridgeServer] Publish failed: ${err.message}`, err.stack);
    return res.status(500).json({
      success: false,
      error: err.message,
      category: 'unknown',
    });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[trypost-browser-publisher] Server listening on http://0.0.0.0:${PORT}`);
});
