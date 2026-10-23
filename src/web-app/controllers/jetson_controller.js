import config from './config.js';

// ------------------------------------------------------------------
// Optional link to the Jetson gate controller (src/main/http_server.py).
// It is only used for gates listed in JETSON_GATES. The Jetson's own
// HTTP API is used as-is:
//   POST /        {"command": "OPEN_DOOR" | "CLOSE_DOOR"}
//   GET  /status  CPU / memory / disk usage and door state
//   GET  /stream  MJPEG camera stream
// ------------------------------------------------------------------
const REQUEST_TIMEOUT_MS = 3000;

export function getJetsonUrl(gateNo) {
    return config.jetsonGates.get(gateNo) ?? null;
}

export function getJetsonGateNumbers() {
    return [...config.jetsonGates.keys()];
}

export async function sendGateCommand(gateNo, gateStatus) {
    const command = gateStatus === 'Open' ? 'OPEN_DOOR' : 'CLOSE_DOOR';
    const response = await fetch(`${getJetsonUrl(gateNo)}/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
        throw new Error(`Jetson replied with HTTP ${response.status}`);
    }
}

export async function getJetsonStatus(gateNo) {
    const response = await fetch(`${getJetsonUrl(gateNo)}/status`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
        throw new Error(`Jetson replied with HTTP ${response.status}`);
    }
    return response.json();
}

// The caller aborts `signal` when the browser stops watching the stream.
// Only connecting is time-limited; the stream itself runs until aborted.
export async function openJetsonStream(gateNo, signal) {
    const controller = new AbortController();
    signal.addEventListener('abort', () => controller.abort(), { once: true });
    const connectTimer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response;
    try {
        response = await fetch(`${getJetsonUrl(gateNo)}/stream`, { signal: controller.signal });
    } finally {
        clearTimeout(connectTimer);
    }
    if (!response.ok || !response.body) {
        throw new Error(`Jetson replied with HTTP ${response.status}`);
    }
    return response;
}
