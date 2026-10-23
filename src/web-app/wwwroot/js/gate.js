const socket = window.socket;
const cameraFeeds = [...document.querySelectorAll('.camera-feed')];

const feedFor = (gateNo) => document.querySelector(`.camera-feed[data-gate-no="${gateNo}"]`);

// Shows a gate's status ('Open' or 'Closed') on its card
function renderGate(gate) {
    const feed = feedFor(gate.gate_no);
    if (!feed) return;

    const status = gate.gate_status.toLowerCase();
    const statusText = feed.querySelector('.status');
    feed.setAttribute('data-status', status);
    statusText.textContent = `Status: ${gate.gate_status}`;
    statusText.className = `status ${status}`;

    // Update button active states
    feed.querySelector('.btn.open').classList.toggle('active', status === 'open');
    feed.querySelector('.btn.close').classList.toggle('active', status === 'closed');
}

async function postJson(url, body) {
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return { ok: response.ok, data: await response.json() };
}

// Asks the server to open or close a gate. The server checks the user's permission.
async function changeGate(gateNo, newStatus) {
    try {
        const { ok, data } = await postJson('/update_gate_data', { gate_no: gateNo, new_status: newStatus });
        if (!ok) {
            alert(data.message ?? data.error ?? 'The gate could not be changed.');
            return;
        }
        renderGate(data.gate);
        if (jetsonGates.has(gateNo)) {
            // Give the motor a moment, then show the Jetson's door reading
            setTimeout(() => showJetsonStatus(gateNo), 2000);
        }
    } catch (error) {
        console.error('Gate update failed:', error);
        alert('Could not reach SmartGate. Please check your connection.');
    }
}

// --- Gates linked to a Jetson show its camera and live details ---
let jetsonGates = new Set();

function jetsonInfoFor(feed) {
    let info = feed.querySelector('.jetson-info');
    if (!info) {
        info = document.createElement('span');
        info.className = 'jetson-info';
        feed.querySelector('.feed-info').appendChild(info);
    }
    return info;
}

async function showJetsonStatus(gateNo) {
    const info = jetsonInfoFor(feedFor(gateNo));
    try {
        const response = await fetch(`/api/gates/${gateNo}/status`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const status = await response.json();
        info.textContent = `Door: ${status.door_state} · CPU ${status.cpu_temperature}, ${status.cpu_usage}`;
    } catch (error) {
        info.textContent = 'Gate controller offline';
    }
}

function connectJetson(gateNo) {
    const feed = feedFor(gateNo);
    if (!feed) return;

    // Show the live camera, falling back to the card's photo if it can't be reached
    const image = feed.querySelector('img');
    const photo = image.src;
    image.addEventListener('error', () => { image.src = photo; }, { once: true });
    image.src = `/api/gates/${gateNo}/stream`;

    showJetsonStatus(gateNo);
}

// --- Load the gates when the page opens ---
async function loadGates() {
    try {
        const response = await fetch('/api/gates');
        const { gates, jetson_gates: linkedGates } = await response.json();

        // Register any gate on this page that isn't in the database yet
        const known = new Set(gates.map(gate => gate.gate_no));
        const missing = cameraFeeds
            .map(feed => Number(feed.dataset.gateNo))
            .filter(gateNo => !known.has(gateNo));
        await Promise.all(missing.map(gateNo => postJson('/add_gate_data', { gate_no: gateNo, gate_status: 'Closed' })));

        gates.forEach(renderGate);
        missing.forEach(gateNo => renderGate({ gate_no: gateNo, gate_status: 'Closed' }));

        jetsonGates = new Set(linkedGates);
        jetsonGates.forEach(connectJetson);
    } catch (error) {
        console.error('Could not load gates:', error);
    }
}

cameraFeeds.forEach(feed => {
    const gateNo = Number(feed.dataset.gateNo);
    feed.querySelector('.btn.open').addEventListener('click', () => changeGate(gateNo, 'Open'));
    feed.querySelector('.btn.close').addEventListener('click', () => changeGate(gateNo, 'Closed'));
});

// Another user opened or closed a gate
socket.on('gate_update', renderGate);

loadGates();
