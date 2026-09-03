import { configureEcho } from '@laravel/echo-vue';

const isHttps = typeof window !== 'undefined' && window.location.protocol === 'https:';

configureEcho({
    broadcaster: 'reverb',
    key: import.meta.env.VITE_REVERB_APP_KEY || 'trypost-reverb-key',
    wsHost: import.meta.env.VITE_REVERB_HOST || (typeof window !== 'undefined' ? window.location.hostname : 'localhost'),
    wsPort: import.meta.env.VITE_REVERB_PORT ?? (isHttps ? 443 : 80),
    wssPort: import.meta.env.VITE_REVERB_PORT ?? 443,
    forceTLS: import.meta.env.VITE_REVERB_SCHEME ? import.meta.env.VITE_REVERB_SCHEME === 'https' : isHttps,
    enabledTransports: ['ws', 'wss'],
});
