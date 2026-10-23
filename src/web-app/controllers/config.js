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

// Optional link from gate numbers to the Jetson that controls them,
// e.g. JETSON_GATES=1=http://192.168.1.50:8080,2=http://192.168.1.51:8080
function getJetsonGates() {
    const gates = new Map();
    for (const entry of (env.JETSON_GATES ?? '').split(',')) {
        if (!entry.trim()) continue;
        const [gateNo, url] = entry.split('=').map(part => part.trim());
        if (!Number.isInteger(Number(gateNo)) || !url) {
            throw new Error(`Invalid JETSON_GATES entry "${entry}". Expected <gate number>=<url>.`);
        }
        gates.set(Number(gateNo), url.replace(/\/+$/, ''));
    }
    return gates;
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
    jetsonGates: getJetsonGates(),
};

export default config;
