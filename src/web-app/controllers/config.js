import crypto from 'node:crypto';

// ---------------------------------------------------------
// Settings read from environment variables (see .env.example)
// ---------------------------------------------------------
const env = process.env;

const isDevelopment = (env.ENV ?? 'development') !== 'production';

function getSessionSecret() {
    if (env.SESSION_SECRET) {
        if (env.SESSION_SECRET.length < 32) {
            throw new Error('SESSION_SECRET must be at least 32 characters long.');
        }
        return env.SESSION_SECRET;
    }
    // Without a fixed secret, everyone is logged out whenever the server restarts.
    console.warn('[WARN] SESSION_SECRET is not set. Using a random one for this run.');
    return crypto.randomBytes(32).toString('hex');
}

// Comma-separated GitHub usernames that are given the admin role when they log in
function getAdminUsers() {
    return (env.ADMIN_USERS ?? '')
        .split(',')
        .map(name => name.trim().toLowerCase())
        .filter(Boolean);
}

// Address of the Jetson's live monitoring service (src/main/live_api.py),
// e.g. JETSON_LIVE_URL=http://192.168.1.50:8081
function getJetsonLiveUrl() {
    const value = (env.JETSON_LIVE_URL ?? '').trim();
    if (!value) {
        return null;
    }
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error(`JETSON_LIVE_URL must start with http:// or https:// (got "${value}").`);
    }
    return url.origin + url.pathname.replace(/\/+$/, '');
}

const config = {
    port: Number(env.PORT ?? 8000),
    databaseUrl: env.DATABASE_URL,
    isDevelopment,
    sessionSecret: getSessionSecret(),
    github: {
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET,
    },
    adminUsers: getAdminUsers(),
    jetsonLiveUrl: getJetsonLiveUrl(),
};

export default config;
