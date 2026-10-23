import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import fastifyOAuth2 from '@fastify/oauth2';
import config from './config.js';
import {
    addAlert,
    addGate,
    checkDbConnection,
    checkPermission,
    deleteAlerts,
    getGates,
    getStats,
    insertUser,
    markUserLoggedIn,
    markUserLoggedOut,
    removeUser,
    updateGateStatus,
    userExists,
} from './db_controller.js';
import {
    broadcastAlertData,
    broadcastGateUpdate,
    broadcastUserOverview,
    kickUser,
} from './websocket_events.js';
import {
    getJetsonGateNumbers,
    getJetsonStatus,
    getJetsonUrl,
    openJetsonStream,
    sendGateCommand,
} from './jetson_controller.js';

const FRONTEND_DIR = path.join(import.meta.dirname, '..', 'frontend');
const DUMMY_AVATAR_URL = 'https://cdn-icons-png.flaticon.com/512/1674/1674295.png';

// Each page is frontend/layout.html with the page's HTML placed inside it
const PAGES = [
    { url: '/', file: 'Index.html', title: 'Dashboard', page: 'dashboard' },
    { url: '/gates', file: 'gates.html', title: 'Gates', page: 'gates' },
    { url: '/alerts', file: 'alerts.html', title: 'Alerts', page: 'alerts' },
    { url: '/users', file: 'users.html', title: 'Users', page: 'users' },
    { url: '/stats', file: 'stats.html', title: 'Stats', page: 'stats' },
    { url: '/about', file: 'about.html', title: 'About Us', page: 'about' },
];

// -------------------
// Helper Functions
// -------------------
function escapeHtml(text) {
    return String(text)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

// Pages are re-read on every request in development so HTML edits show up on refresh
const templateCache = new Map();

async function readTemplate(file) {
    if (!config.isDevelopment && templateCache.has(file)) {
        return templateCache.get(file);
    }
    const html = await fs.readFile(path.join(FRONTEND_DIR, file), 'utf8');
    templateCache.set(file, html);
    return html;
}

// Replaces {{name}} placeholders in a template
function fillTemplate(template, values) {
    return template.replace(/{{(\w+)}}/g, (match, key) => values[key] ?? '');
}

function renderUserSection(user) {
    if (user) {
        return `<div class="user-info">
            <div class="profile-avatar">
                <img src="${escapeHtml(user.avatar_url)}" alt="User Avatar" class="profile-pic">
            </div>
            <div class="user-menu" id="userMenu">
                <p class="username">Username: ${escapeHtml(user.username)}</p>
                <a href="/logout" class="logout-btn">Logout</a>
            </div>
        </div>`;
    }

    // The dummy login is only for testing, so it is hidden in production
    const dummyLogin = config.isDevelopment
        ? '<a href="/dummy-login" class="dummy-login-btn">DUMMY LOGIN</a>'
        : '';
    return `<div class="login-btns">
            ${dummyLogin}
            <a href="/login" class="login-btn">LOGIN</a>
            <style>
                nav {
                    margin-left: 125px;
                }
            </style>
        </div>`;
}

// Returns the logged-in user, or null. Users removed from the database are logged out.
async function getCurrentUser(request) {
    const user = request.session?.get('user');
    if (!user) {
        return null;
    }
    if (await userExists(user.username)) {
        return user;
    }
    await request.session.destroy();
    return null;
}

async function logIn(request, { id, login, avatarUrl }) {
    await insertUser({ id, login, isAdmin: config.adminUsers.includes(login.toLowerCase()) });
    await markUserLoggedIn(login);
    // A fresh session on login stops anyone reusing a session id from before login
    await request.session.regenerate();
    request.session.set('user', { username: login, avatar_url: avatarUrl });
}

// -------------------
// Request Schemas
// -------------------
const gateNoSchema = { type: 'integer', minimum: 1 };
const gateStatusSchema = { type: 'string', enum: ['Open', 'Closed'] };

const gateParamsSchema = {
    type: 'object',
    required: ['gateNo'],
    properties: { gateNo: gateNoSchema },
};

// -------------
// Routes
// -------------
export async function rootRoutes(app) {
    const io = app.io;

    // --- Web pages ---
    for (const page of PAGES) {
        app.get(page.url, async (request, reply) => {
            const user = await getCurrentUser(request);
            const [layout, content] = await Promise.all([readTemplate('layout.html'), readTemplate(page.file)]);
            reply.type('text/html; charset=utf-8');
            return fillTemplate(layout, {
                title: page.title,
                page: page.page,
                user_section: renderUserSection(user),
                content,
            });
        });
    }

    // --- Login with GitHub ---
    if (config.github.clientId && config.github.clientSecret) {
        await app.register(fastifyOAuth2, {
            name: 'githubOAuth2',
            scope: ['user:email'],
            credentials: {
                client: { id: config.github.clientId, secret: config.github.clientSecret },
                auth: fastifyOAuth2.GITHUB_CONFIGURATION,
            },
            startRedirectPath: '/login',
            callbackUri: (request) => `${request.protocol}://${request.host}/auth`,
        });

        app.get('/auth', async (request, reply) => {
            // The user pressed "Cancel" on GitHub
            if (request.query.error) {
                return reply.redirect('/');
            }

            const { token } = await app.githubOAuth2.getAccessTokenFromAuthorizationCodeFlow(request, reply);
            const response = await fetch('https://api.github.com/user', {
                headers: {
                    Authorization: `Bearer ${token.access_token}`,
                    Accept: 'application/vnd.github+json',
                    'User-Agent': 'SmartGate',
                },
            });
            if (!response.ok) {
                throw new Error(`GitHub user lookup failed with HTTP ${response.status}`);
            }
            const githubUser = await response.json();

            await logIn(request, { id: githubUser.id, login: githubUser.login, avatarUrl: githubUser.avatar_url });
            await broadcastUserOverview(io);
            return reply.redirect('/gates');
        });
    } else {
        app.get('/login', async (request, reply) => {
            reply.code(503).type('text/html; charset=utf-8');
            return '<h1>GitHub login is not set up</h1>'
                + '<p>Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET (see .env.example) and restart SmartGate.</p>'
                + '<p><a href="/">Back to SmartGate</a></p>';
        });
    }

    if (config.isDevelopment) {
        app.get('/dummy-login', async (request, reply) => {
            await logIn(request, { id: 9999, login: 'Dummy', avatarUrl: DUMMY_AVATAR_URL });
            await broadcastUserOverview(io);
            return reply.redirect('/gates');
        });
    }

    app.get('/logout', async (request, reply) => {
        const user = request.session?.get('user');
        if (user) {
            await markUserLoggedOut(user.username);
            await request.session.destroy();
            await broadcastUserOverview(io);
        }
        return reply.redirect('/');
    });

    app.get('/removed', async (request, reply) => {
        await request.session?.destroy();
        return reply.redirect('/');
    });

    // --- Status and session information ---
    app.get('/health', { logLevel: 'warn' }, async (request, reply) => {
        try {
            if (!(await checkDbConnection())) {
                return reply.code(500).send({ status: 'unhealthy', reason: 'Database unavailable' });
            }
            return { 'web-status': 'ok', 'db-status': 'ok' };
        } catch (err) {
            return reply.code(500).send({ status: 'unhealthy', reason: err.message });
        }
    });

    app.get('/get-username', async (request) => {
        const user = await getCurrentUser(request);
        return user ? { username: user.username } : { error: 'Not logged in' };
    });

    app.get('/get-session-username', async (request, reply) => {
        const user = await getCurrentUser(request);
        if (!user) {
            return reply.code(401).send({ detail: 'Not logged in' });
        }
        return { username: user.username };
    });

    // Only answers for the logged-in user, so nobody can look up other users' permissions
    app.get('/check-permission', {
        schema: {
            querystring: {
                type: 'object',
                required: ['perm_name'],
                properties: { username: { type: 'string' }, perm_name: { type: 'string' } },
            },
        },
    }, async (request) => {
        const user = await getCurrentUser(request);
        const { username, perm_name: permName } = request.query;
        if (!user || (username && username !== user.username)) {
            return { allowed: false };
        }
        return { allowed: await checkPermission(user.username, permName) };
    });

    // --- Users ---
    app.post('/remove-user', {
        schema: {
            body: {
                type: 'object',
                required: ['username'],
                properties: { username: { type: 'string', minLength: 1 } },
            },
        },
    }, async (request, reply) => {
        const user = await getCurrentUser(request);
        if (!user) {
            return reply.code(401).send({ alert: 'You need to log in to remove users.' });
        }

        const { username } = request.body;
        if (username === user.username) {
            return reply.code(400).send({ alert: 'You cannot remove yourself.' });
        }
        if (!(await checkPermission(user.username, 'data_control'))) {
            return reply.code(403).send({ alert: "You don't have permission to remove users." });
        }

        await removeUser(username);
        kickUser(io, username);
        await broadcastUserOverview(io);
        return { message: `User ${username} removed and kicked out!` };
    });

    // --- Alerts ---
    app.post('/api/alerts/delete', {
        schema: {
            body: {
                type: 'object',
                required: ['alert_nos'],
                properties: { alert_nos: { type: 'array', minItems: 1, items: { type: 'integer' } } },
            },
        },
    }, async (request, reply) => {
        const user = await getCurrentUser(request);
        if (!user) {
            return reply.code(401).send({ message: 'You need to log in to remove alerts.' });
        }
        if (!(await checkPermission(user.username, 'data_control'))) {
            return reply.code(403).send({ message: "You don't have permission to remove alerts." });
        }

        const removed = await deleteAlerts(request.body.alert_nos);
        await broadcastAlertData(io);
        return { message: `${removed} alert(s) removed` };
    });

    // --- Gates ---
    app.get('/api/gates', async () => ({
        gates: await getGates(),
        jetson_gates: getJetsonGateNumbers(),
    }));

    // Registers a gate if it is not in the database yet
    app.post('/add_gate_data', {
        schema: {
            body: {
                type: 'object',
                required: ['gate_no', 'gate_status'],
                properties: { gate_no: gateNoSchema, gate_status: gateStatusSchema },
            },
        },
    }, async (request) => {
        const { gate_no: gateNo, gate_status: gateStatus } = request.body;
        await addGate(gateNo, gateStatus);
        return { message: `Gate ${gateNo} status ${gateStatus} added successfully` };
    });

    // Opens or closes a gate
    app.post('/update_gate_data', {
        schema: {
            body: {
                type: 'object',
                required: ['gate_no', 'new_status'],
                properties: { gate_no: gateNoSchema, new_status: gateStatusSchema },
            },
        },
    }, async (request, reply) => {
        const { gate_no: gateNo, new_status: newStatus } = request.body;
        const action = newStatus === 'Open' ? 'open' : 'close';

        const user = await getCurrentUser(request);
        if (!user) {
            return reply.code(401).send({ message: `You need to log in to ${action} the gate.` });
        }
        if (!(await checkPermission(user.username, `${action}_gate`))) {
            return reply.code(403).send({ message: `You don't have permission to ${action} the gate.` });
        }

        // Move the real gate first, if this gate is linked to a Jetson
        if (getJetsonUrl(gateNo)) {
            try {
                await sendGateCommand(gateNo, newStatus);
            } catch (err) {
                request.log.warn(`Gate ${gateNo} Jetson command failed: ${err.message}`);
                await addAlert(`Gate #${gateNo} controller could not be reached`, 'critical');
                await broadcastAlertData(io);
                return reply.code(502).send({
                    message: `Could not reach the controller for gate ${gateNo}, so the gate was not moved.`,
                });
            }
        }

        const { gate, changed } = await updateGateStatus(gateNo, newStatus);
        if (changed) {
            await addAlert(`Gate #${gateNo} ${newStatus === 'Open' ? 'Opened' : 'Closed'} by ${user.username}`, 'info');
            broadcastGateUpdate(io, gate);
            await broadcastAlertData(io);
        }
        return { message: `Gate ${gateNo} status ${newStatus} updated successfully`, gate };
    });

    app.get('/api/gates/:gateNo/status', { schema: { params: gateParamsSchema } }, async (request, reply) => {
        const { gateNo } = request.params;
        if (!getJetsonUrl(gateNo)) {
            return reply.code(404).send({ error: 'This gate is not linked to a Jetson.' });
        }
        try {
            return await getJetsonStatus(gateNo);
        } catch (err) {
            request.log.warn(`Gate ${gateNo} Jetson status failed: ${err.message}`);
            return reply.code(502).send({ error: 'The gate controller could not be reached.' });
        }
    });

    // Passes the Jetson's live camera stream through to the browser
    app.get('/api/gates/:gateNo/stream', { schema: { params: gateParamsSchema } }, async (request, reply) => {
        const { gateNo } = request.params;
        if (!getJetsonUrl(gateNo)) {
            return reply.code(404).send({ error: 'This gate is not linked to a Jetson.' });
        }

        const browserGone = new AbortController();
        reply.raw.on('close', () => browserGone.abort());

        let response;
        try {
            response = await openJetsonStream(gateNo, browserGone.signal);
        } catch (err) {
            request.log.warn(`Gate ${gateNo} Jetson stream failed: ${err.message}`);
            return reply.code(502).send({ error: 'The gate camera could not be reached.' });
        }

        const stream = Readable.fromWeb(response.body);
        // Stopping the stream when the browser leaves is expected, not an error
        stream.on('error', () => {});
        reply.header('Content-Type', response.headers.get('content-type'));
        reply.header('Cache-Control', 'no-store');
        return reply.send(stream);
    });

    // --- Stats ---
    app.get('/api/stats', async () => getStats());
}
