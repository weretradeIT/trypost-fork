import { configureEcho } from '@laravel/echo-vue';

const isBrowser = typeof window !== 'undefined';
const isHttps = isBrowser && window.location.protocol === 'https:';

configureEcho({
    broadcaster: 'reverb',
    key: import.meta.env.VITE_REVERB_APP_KEY || 'trypost-reverb-key',
    wsHost: isBrowser ? window.location.hostname : 'localhost',
    wsPort: isHttps ? 443 : 80,
    wssPort: 443,
    forceTLS: isHttps,
    enabledTransports: ['ws', 'wss'],
});

