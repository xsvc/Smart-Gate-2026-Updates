import config from './config.js';

// ------------------------------------------------------------------
// Live link to the Jetson's monitoring service (src/main/live_api.py).
// Node connects to its WebSocket as a client and forwards the events to
// browsers on the Live Stream page through Socket.IO (room "live").
// Event contract and connection states: docs/LIVE_MONITORING.md
// ------------------------------------------------------------------
export const LIVE_ROOM = 'live';

const CONNECT_TIMEOUT_MS = 5000;
const STALE_AFTER_MS = 5000; // The Jetson sends "status" every second
const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000];
const STREAM_CONNECT_TIMEOUT_MS = 3000;
const EVENT_TYPES = new Set(['snapshot', 'status', 'detection']);

// What browsers are told. state: connecting | connected | disconnected | error
const live = {
    connection: { state: 'disconnected', reason: null, last_update: null },
    status: null,
    detection: null,
};

let io = null;
let log = null;
let jetsonSocket = null;
let lastMessageAt = 0;
let reconnectAttempt = 0;
let reconnectTimer = null;
let staleTimer = null;
let stopped = false;

export function getLiveSnapshot() {
    return { ...live };
}

const emitToLivePage = (event, data) => io?.to(LIVE_ROOM).emit(event, data);

function setConnection(state, reason = null) {
    if (live.connection.state === state && live.connection.reason === reason) return;
    live.connection = { ...live.connection, state, reason };
    // Readings are only shown while they are live, never stale
    if (state !== 'connected' && live.status !== null) {
        live.status = null;
        emitToLivePage('live_status', null);
    }
    emitToLivePage('live_connection', live.connection);
    log.info(`Jetson live connection: ${state}${reason ? ` (${reason})` : ''}`);
}

function handleMessage(raw) {
    let message;
    try {
        message = JSON.parse(raw);
    } catch {
        log.warn('Ignored a message from the Jetson that is not JSON');
        return;
    }
    if (!EVENT_TYPES.has(message?.type) || typeof message.data !== 'object') {
        log.warn(`Ignored an unknown message from the Jetson: ${String(raw).slice(0, 120)}`);
        return;
    }

    lastMessageAt = Date.now();
    reconnectAttempt = 0;
    if (live.connection.state !== 'connected') {
        log.info('Jetson live connection: connected');
    }
    live.connection = { state: 'connected', reason: null, last_update: new Date(lastMessageAt).toISOString() };

    if (message.type === 'snapshot') {
        live.status = message.data?.status ?? null;
        live.detection = message.data?.detection ?? live.detection;
        emitToLivePage('live_status', live.status);
        if (live.detection) emitToLivePage('live_detection', live.detection);
    } else if (message.type === 'status') {
        live.status = message.data;
        emitToLivePage('live_status', live.status);
    } else if (message.type === 'detection') {
        live.detection = message.data;
        emitToLivePage('live_detection', live.detection);
    }
    emitToLivePage('live_connection', live.connection);
}

function scheduleReconnect() {
    if (stopped) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
    reconnectAttempt++;
    reconnectTimer = setTimeout(connect, delay);
}

function connect() {
    const wsUrl = `${config.jetsonLiveUrl.replace(/^http/, 'ws')}/ws/events`;
    setConnection('connecting', reconnectAttempt > 0 ? `Reconnect attempt ${reconnectAttempt}` : null);

    const ws = new WebSocket(wsUrl);
    jetsonSocket = ws;
    let closeReason = null;

    const connectTimer = setTimeout(() => {
        if (ws.readyState === WebSocket.CONNECTING) {
            closeReason = 'Connection timed out';
            ws.close();
        }
    }, CONNECT_TIMEOUT_MS);

    ws.addEventListener('message', (event) => handleMessage(event.data));
    ws.addEventListener('error', (event) => {
        closeReason ??= event.message || 'Could not connect';
    });
    ws.addEventListener('close', (event) => {
        clearTimeout(connectTimer);
        if (jetsonSocket !== ws) return;
        jetsonSocket = null;
        if (stopped) return;
        // Keep an "error" state (e.g. stalled data) visible until the next attempt starts
        if (live.connection.state !== 'error') {
            setConnection('disconnected', closeReason ?? (event.reason || `Connection closed (code ${event.code})`));
        }
        scheduleReconnect();
    });
}

// A connection that stays open but stops sending data counts as an error.
// A frozen Jetson may never finish closing it, so retry straight away instead of waiting.
function checkStale() {
    if (live.connection.state === 'connected' && Date.now() - lastMessageAt > STALE_AFTER_MS) {
        setConnection('error', `No data from the Jetson for ${STALE_AFTER_MS / 1000} seconds`);
        const staleSocket = jetsonSocket;
        jetsonSocket = null; // Its close event is now ignored
        staleSocket?.close();
        scheduleReconnect();
    }
}

export function startJetsonLive(ioServer, logger) {
    io = ioServer;
    log = logger;
    if (!config.jetsonLiveUrl) {
        live.connection = { state: 'disconnected', reason: 'JETSON_LIVE_URL is not set', last_update: null };
        log.warn('JETSON_LIVE_URL is not set, so the Live Stream page will show the Jetson as disconnected.');
        return;
    }
    connect();
    staleTimer = setInterval(checkStale, 1000);
}

export function stopJetsonLive() {
    stopped = true;
    clearTimeout(reconnectTimer);
    clearInterval(staleTimer);
    jetsonSocket?.close();
}

// Opens the Jetson's MJPEG stream. The caller aborts `signal` when the browser leaves.
// Only connecting is time-limited; the stream itself runs until aborted.
export async function openLiveStream(signal) {
    if (!config.jetsonLiveUrl) {
        throw new Error('JETSON_LIVE_URL is not set');
    }
    const controller = new AbortController();
    signal.addEventListener('abort', () => controller.abort(), { once: true });
    const connectTimer = setTimeout(() => controller.abort(), STREAM_CONNECT_TIMEOUT_MS);

    let response;
    try {
        response = await fetch(`${config.jetsonLiveUrl}/stream`, { signal: controller.signal });
    } finally {
        clearTimeout(connectTimer);
    }
    if (!response.ok || !response.body) {
        throw new Error(`Jetson replied with HTTP ${response.status}`);
    }
    return response;
}
