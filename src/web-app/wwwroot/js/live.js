// Live Stream page: shows the Jetson's camera and the readings it sends.
// Every value comes from the Jetson; anything missing is shown as "Unavailable".
const socket = window.socket;

const UNAVAILABLE = "Unavailable";
const STREAM_URL = "/api/live/stream";
const STREAM_RETRY_MS = 5000;

const CONNECTION_LABELS = { connected: "Connected", connecting: "Connecting", disconnected: "Disconnected", error: "Error" };
const CAMERA_LABELS = { ok: "Operational", starting: "Starting", no_frames: "No frames", unavailable: null };

const byId = (id) => document.getElementById(id);
const streamImage = byId("liveStream");
const cameraMessage = byId("cameraMessage");

let connection = { state: "connecting", reason: null, last_update: null };
let status = null;
let detection = null;
let lastLiveAt = null;      // When this browser last received live data
let streamActive = false;
let retryTimer = null;

// --- Small display helpers ---
function show(id, value) {
    const element = byId(id);
    const missing = value === null || value === undefined || value === "";
    element.textContent = missing ? UNAVAILABLE : value;
    element.classList.toggle("unavailable", missing);
}

function setBadge(id, text, className) {
    const badge = byId(id);
    badge.textContent = text;
    badge.className = `badge ${className}`;
}

const percent = (value) => (typeof value === "number" ? `${value.toFixed(1)}%` : null);
const isLive = () => connection.state === "connected" && status !== null;

// --- Jetson connection ---
function renderConnection() {
    setBadge("connectionBadge", CONNECTION_LABELS[connection.state] ?? "Unknown", connection.state);
    show("connectionReason", connection.reason ?? (connection.state === "connected" ? "Receiving live data" : null));
    renderLastUpdate();
}

function renderLastUpdate() {
    if (connection.state === "connected" && lastLiveAt) {
        const seconds = Math.round((Date.now() - lastLiveAt) / 1000);
        show("lastUpdate", `${new Date(lastLiveAt).toLocaleTimeString()} (${seconds}s ago)`);
    } else {
        show("lastUpdate", connection.last_update ? new Date(connection.last_update).toLocaleString() : null);
    }
}

// --- System, camera, sensors and model readings ---
function renderStatus() {
    const live = isLive();
    const camera = live ? status.camera : null;
    const system = live ? status.system : null;
    const sensors = live ? status.sensors : null;

    show("cpuUsage", percent(system?.cpu_percent));
    show("memoryUsage", percent(system?.memory_percent));
    show("temperature", typeof system?.temperature_c === "number"
        ? `${system.temperature_c.toFixed(1)} °C` : null);

    const cameraOk = camera?.status === "ok";
    show("cameraStatus", cameraOk ? `Operational (${camera.fps} fps)` : CAMERA_LABELS[camera?.status] ?? null);
    if (cameraOk) setBadge("cameraBadge", "Live", "ok");
    else if (camera) setBadge("cameraBadge", "No signal", "error");
    else setBadge("cameraBadge", UNAVAILABLE, "disconnected");

    show("pirMotion", typeof sensors?.pir_motion === "boolean"
        ? (sensors.pir_motion ? "Motion detected" : "No motion") : null);
    show("hallOpen", hallReading(sensors?.hall_open));
    show("hallClose", hallReading(sensors?.hall_close));
    show("gatePosition", sensors?.gate_position);

    updateStream(cameraOk, camera);
    renderDetection();
}

function hallReading(value) {
    return typeof value === "number" ? `${value} (${value ? "HIGH" : "LOW"})` : null;
}

// --- Animal recognition (only while the AI model is running) ---
function renderDetection() {
    const model = isLive() ? status.model : null;
    const modelReady = model?.ready === true;
    show("modelStatus", modelReady ? "Running" : null);
    show("modelName", modelReady ? model.name : null);

    if (!modelReady) {
        ["detectedAnimal", "detectedConfidence", "detectedAt", "detectedOthers"].forEach(id => show(id, null));
        return;
    }
    if (!detection) {
        show("detectedAnimal", "None detected yet");
        ["detectedConfidence", "detectedAt", "detectedOthers"].forEach(id => show(id, null));
        return;
    }

    show("detectedAnimal", detection.top?.name);
    show("detectedConfidence", typeof detection.top?.confidence === "number"
        ? `${detection.top.confidence.toFixed(1)}%` : null);
    show("detectedAt", detection.detected_at ? new Date(detection.detected_at).toLocaleString() : null);
    const others = (detection.animals ?? []).slice(1).map(a => `${a.name} (${a.confidence.toFixed(1)}%)`);
    show("detectedOthers", others.length ? others.join(", ") : "None");
}

// --- Camera stream ---
function cameraProblem(camera) {
    if (connection.state === "connecting") return "Connecting to the Jetson...";
    if (connection.state === "error") return "Live data from the Jetson has stopped. Reconnecting...";
    if (connection.state !== "connected") return "The Jetson is disconnected. Waiting for it to come back...";
    if (camera?.status === "starting") return "The camera is starting...";
    return "The camera is not sending frames. The Jetson will try to reconnect it.";
}

function updateStream(cameraOk, camera) {
    if (cameraOk && !streamActive && !retryTimer) {
        startStream();
    } else if (!cameraOk) {
        stopStream(cameraProblem(camera));
    }
}

function startStream() {
    streamActive = true;
    // A new URL each time forces a fresh connection
    streamImage.src = `${STREAM_URL}?t=${Date.now()}`;
    cameraMessage.hidden = true;
}

function stopStream(message) {
    clearTimeout(retryTimer);
    retryTimer = null;
    streamActive = false;
    streamImage.removeAttribute("src"); // Closes the stream connection
    cameraMessage.textContent = message;
    cameraMessage.hidden = false;
}

// The stream connection failed or dropped: try again shortly
streamImage.addEventListener("error", () => {
    if (!streamActive) return;
    stopStream("The camera stream was interrupted. Reconnecting...");
    retryTimer = setTimeout(() => {
        retryTimer = null;
        renderStatus();
    }, STREAM_RETRY_MS);
});

// --- Live events from the web server ---
socket.on("live_connection", (data) => {
    connection = data;
    if (connection.state === "connected") lastLiveAt = Date.now();
    renderConnection();
    renderStatus();
});

socket.on("live_status", (data) => {
    status = data;
    if (data) lastLiveAt = Date.now();
    renderStatus();
});

socket.on("live_detection", (data) => {
    detection = data;
    renderDetection();
});

// The SmartGate web server itself is unreachable
socket.on("disconnect", () => {
    connection = { ...connection, state: "disconnected", reason: "Lost connection to the SmartGate web server" };
    status = null;
    renderConnection();
    renderStatus();
});

// Join the live updates on connect (and again after any reconnect)
const subscribe = () => socket.emit("live_subscribe");
socket.on("connect", subscribe);
if (socket.connected) subscribe();

renderConnection();
renderStatus();
setInterval(renderLastUpdate, 1000);
