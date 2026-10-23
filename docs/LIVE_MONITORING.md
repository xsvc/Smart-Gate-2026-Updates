# SmartGate Live Monitoring

The **LIVE STREAM** page of the SmartGate website (`/gates`) shows the Jetson Orin Nano's camera
and readings in real time. This document describes how the data gets there, the message formats,
and how connection problems are handled.

## Architecture

```
Jetson Orin Nano (one Python program: src/main/live_detection.py)
 ├─ CameraReader thread ── reads every camera frame (camera_reader.py)
 ├─ Main loop ──────────── PIR → detect → decide → open/close (unchanged)
 │      └─ after each detection: publish_detections()
 ├─ http_server.py ─────── port 8080 (unchanged: /, /stream, /status, POST commands)
 └─ live_api.py (FastAPI) ─ port 8081 ("live_port" in config/config.json)
        ├─ GET /stream      MJPEG video
        └─ WS  /ws/events   snapshot / status / detection events
                │
                ▼
SmartGate web app (Node.js, src/web-app)
 ├─ controllers/jetson_live.js  WebSocket client → tracks connection state, reconnects
 ├─ GET /api/live/stream        relays the MJPEG video to browsers
 ├─ GET /api/live/status        current state as JSON (for debugging)
 └─ Socket.IO room "live"       pushes events to browsers on the page
                │
                ▼
Browser (wwwroot/js/live.js) — updates the page with no refreshes
```

The live service runs **inside** `live_detection.py` because that program owns the camera and the
GPIO pins; another process cannot read them at the same time. Video uses MJPEG (an `<img>` tag),
never Socket.IO. The website only **reads** from the Jetson; it never opens or closes the gate.

## Setup

**On the Jetson**

1. `config/config.json` → `"server": { "port": 8080, "live_port": 8081 }`. Remove `live_port` to turn
   the live service off. **Check that port 8081 is free on your Jetson** before using it.
2. Rebuild the image (`make build`) — the `Dockerfile` installs `fastapi`, `uvicorn` and `websockets`.
3. Run as usual (`make run` → `python3 src/main/live_detection.py`, or the `smartgate` service).
   The log shows `[+] Live API running under port 8081`. `--network host` is used, so no port mapping
   is needed.
4. Check from your laptop: `http://<jetson-ip>:8081/health` should return `{"status":"ok", ...}`.

If FastAPI is not installed (e.g. the original Jetson Nano on Python 3.6), the log shows
`[!] Live monitoring disabled (...)` and SmartGate runs exactly as before.

**On the web app** (`src/web-app/.env`)

```
JETSON_LIVE_URL=http://<jetson-ip>:8081
```

If the web app runs in Docker on the Jetson itself, use `http://host.docker.internal:8081`.
Restart the web app (`docker-compose up -d`). Its log shows `Jetson live connection: connected`.

## Jetson → Node: WebSocket events (`ws://<jetson>:8081/ws/events`)

Every message is JSON: `{ "type": ..., "ts": "<UTC ISO time>", "data": {...} }`.

| type | When | data |
|---|---|---|
| `snapshot` | Once, right after connecting | `{ "status": <status>, "detection": <detection or null> }` |
| `status` | Every second | `<status>` |
| `detection` | Each time the model detects at least one animal | `<detection>` |

**status**

```json
{
  "camera":  { "status": "ok", "fps": 28.6, "last_frame_at": "2026-10-23T12:50:03.736Z" },
  "model":   { "ready": true, "name": "marsupial_16s.engine", "confidence_threshold": 0.5 },
  "system":  { "cpu_percent": 12.0, "memory_percent": 35.1, "temperature_c": 41.5, "temperature_sensor": "cpu-thermal" },
  "sensors": { "pir_motion": false, "hall_open": 1, "hall_close": 0, "gate_position": "Closed",
               "door_opening": false, "door_closing": false }
}
```

- `camera.status`: `ok` (frame in the last 2 s), `starting` (no frame yet), `no_frames`, `unavailable`.
- `system`: from `psutil`. `temperature_c` is `null` if no known thermal zone exists.
- `sensors`: read from the GPIO pins defined in `src/main/io_control.py` (PIR = pin 15, OPEN Hall = 11,
  CLOSE Hall = 13). `gate_position` uses the existing `DoorControl` logic: `Open`, `Closed`,
  `Moving` (motor running between sensors) or `Unknown`. A failed read gives `null`.

**detection**

```json
{
  "animals": [ { "name": "Common Wombat", "confidence": 87.3 }, { "name": "Red Fox", "confidence": 41.2 } ],
  "top": { "name": "Common Wombat", "confidence": 87.3 },
  "detected_at": "2026-10-23T12:51:20.412Z",
  "inference_ms": 12.3
}
```

`confidence` is the model's score as a percentage, sorted highest first. Detections only exist while
the model is running, because they come straight from `YoloTRT.Inference()`.

**HTTP**: `GET /health`, `GET /status` (latest status as JSON), `GET /stream` (MJPEG, up to 15 fps,
JPEG quality 80; for 1.5 s after a detection it shows the frame with the detection boxes).

## Node → browser: Socket.IO events

| Event | Direction | data |
|---|---|---|
| `live_subscribe` | browser → server | none. Joins room `live` and receives the three events below immediately. |
| `live_connection` | server → browser | `{ state, reason, last_update }` — sent on every change and with every message |
| `live_status` | server → browser | the `status` object above, or `null` when not connected |
| `live_detection` | server → browser | the `detection` object above |

## Connection states

| State | Meaning |
|---|---|
| `connecting` | A connection attempt is in progress |
| `connected` | Messages are arriving (at least one in the last 5 s) |
| `disconnected` | No connection (refused, timed out, closed, or `JETSON_LIVE_URL` not set). Retrying. |
| `error` | Connected, but no valid data for 5 s (Jetson frozen or overloaded). The connection is dropped and retried. |

`last_update` is when Node last received a valid message.

## Error handling and reconnection

| Situation | What happens |
|---|---|
| Jetson unreachable | Retry after 1 s, 2 s, 5 s, then every 10 s. Connecting times out after 5 s. |
| Connection open but silent | After 5 s: state `error`, connection dropped, retry starts |
| Invalid / unknown message | Ignored and logged; it does not count as an update |
| Not connected | Readings are cleared and shown as **Unavailable** (never stale values) |
| Camera stops sending frames | Jetson reports `no_frames` within 2 s; `CameraReader` reopens the camera after 5 s |
| Video connection drops | The page shows a message and retries the stream after 5 s; it also restarts the stream whenever the camera or connection comes back |
| Web server unreachable | The browser shows "Disconnected"; Socket.IO reconnects automatically |

## Testing status

**Tested** (on a PC, with the real `live_api.py` and `camera_reader.py` in a Python 3.12 container,
and stand-ins for the camera, GPIO pins, door and model): status every second, detections,
PIR/Hall/gate values, MJPEG relay through Node, camera loss and recovery, Jetson offline and
reconnection, frozen Jetson → `error` → recovery, and the page in Chrome (connected and offline).
`live_detection.py` was syntax-checked on Python 3.12 and 3.6.

**Not tested — needs the real Jetson Orin Nano:**

- [ ] Image builds with the three new packages (`make build`)
- [ ] `live_detection.py` starts, logs `Live API running under port 8081`, gate logic behaves as before
- [ ] Real camera frames appear on the page; frame rate and CPU load are acceptable
- [ ] Temperature appears (which thermal zone name the Orin Nano uses is **UNKNOWN — REQUIRES VERIFICATION**)
- [ ] PIR and Hall values change when the sensors are triggered
- [ ] Detections appear with confidence and time (the Jetson's clock must be correct, e.g. NTP)
- [ ] Port 8081 is free and reachable from the laptop (**UNKNOWN — REQUIRES VERIFICATION**)
- [ ] Unplugging the network / stopping the service shows Disconnected and recovers
