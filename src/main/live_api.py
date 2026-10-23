### Live monitoring service for the SmartGate website. ###
#Runs FastAPI on a background thread inside live_detection.py (it needs the same camera and GPIO
#pins, which only that program can use). The website's Node.js server connects to it.
#
#  GET /health     - Is the service running? Camera and model state
#  GET /status     - Latest camera, model, system and sensor readings (JSON)
#  GET /stream     - Live camera as MJPEG (multipart/x-mixed-replace)
#  WS  /ws/events  - Real-time events, see docs/LIVE_MONITORING.md:
#                    "snapshot" on connect, "status" every second, "detection" on each detection

import asyncio
import os
import threading
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone

import cv2
import psutil
import uvicorn
from fastapi import FastAPI, WebSocket
from fastapi.responses import StreamingResponse

STATUS_INTERVAL_S      = 1.0   #How often the "status" event is sent
CAMERA_STALE_AFTER_S   = 2.0   #Camera counts as down if its newest frame is older than this
MAX_STREAM_FPS         = 15    #Frame rate limit for the MJPEG stream
JPEG_QUALITY           = 80
DETECTION_FRAME_HOLD_S = 1.5   #Show the frame with detection boxes for this long
CLIENT_QUEUE_SIZE      = 50    #Events kept per slow WebSocket client before dropping

#Thermal zones to report as "temperature", in order of preference. The names differ between
#Jetson models, so the first one present is used (the original Jetson Nano used 'thermal-fan-est').
PREFERRED_THERMAL_ZONES = ('cpu-thermal', 'CPU-therm', 'tj-thermal', 'thermal-fan-est')

#References set by start_live_api()
camera          = None   #CameraReader
door_controller = None   #DoorControl
read_pin        = None   #io_control.get_val
model_info      = {'ready': False, 'name': None, 'confidence_threshold': None}

#Shared state
event_loop      = None
clients         = set()   #One asyncio.Queue per connected WebSocket
latest_status   = None
last_detection  = None
detection_frame = None    #(annotated frame, time) from the latest detection
jpeg_cache      = {'key': None, 'jpeg': None}

def _iso(timestamp=None):
    moment = datetime.fromtimestamp(timestamp, timezone.utc) if timestamp else datetime.now(timezone.utc)
    return moment.isoformat(timespec='milliseconds').replace('+00:00', 'Z')

def _event(event_type, data):
    return {'type': event_type, 'ts': _iso(), 'data': data}

#---------------- Readings ----------------
def _camera_status():
    if camera is None:
        return {'status': 'unavailable', 'fps': None, 'last_frame_at': None}
    _, _, frame_time = camera.latest()
    if frame_time is None:
        status = 'starting'
    elif time.time() - frame_time > CAMERA_STALE_AFTER_S:
        status = 'no_frames'
    else:
        status = 'ok'
    return {
        'status': status,
        'fps': round(camera.fps, 1) if status == 'ok' else 0.0,
        'last_frame_at': _iso(frame_time) if frame_time else None,
    }

def _read_temperature():
    try:
        zones = psutil.sensors_temperatures()
    except (AttributeError, OSError):
        return None, None
    for name in PREFERRED_THERMAL_ZONES + tuple(zones):
        if zones.get(name):
            return round(zones[name][0].current, 1), name
    return None, None

def _system_status():
    try:
        temperature, sensor = _read_temperature()
        return {
            'cpu_percent': psutil.cpu_percent(interval=None),
            'memory_percent': psutil.virtual_memory().percent,
            'temperature_c': temperature,
            'temperature_sensor': sensor,
        }
    except Exception as e:
        print(f'[-] Live API: system reading failed: {e}')
        return {'cpu_percent': None, 'memory_percent': None, 'temperature_c': None, 'temperature_sensor': None}

def _sensor_status():
    #Sensor pins and the door logic come from io_control.py and door_control.py
    sensors = {'pir_motion': None, 'hall_open': None, 'hall_close': None,
               'gate_position': 'Unknown', 'door_opening': None, 'door_closing': None}
    try:
        if read_pin is not None:
            sensors['pir_motion'] = bool(read_pin('PIR'))
            sensors['hall_open']  = int(read_pin('OPEN'))
            sensors['hall_close'] = int(read_pin('CLOSE'))
        if door_controller is not None:
            sensors['door_opening'] = door_controller.is_door_opening
            sensors['door_closing'] = door_controller.is_door_closing
            if door_controller.is_door_fully_open():
                sensors['gate_position'] = 'Open'
            elif door_controller.is_door_fully_closed():
                sensors['gate_position'] = 'Closed'
            elif door_controller.is_door_opening or door_controller.is_door_closing:
                sensors['gate_position'] = 'Moving'
    except Exception as e:
        print(f'[-] Live API: sensor reading failed: {e}')
    return sensors

def _read_status():
    return {
        'camera': _camera_status(),
        'model': dict(model_info),
        'system': _system_status(),
        'sensors': _sensor_status(),
    }

#---------------- Event delivery ----------------
def _broadcast(message):
    for queue in list(clients):
        try:
            queue.put_nowait(message)
        except asyncio.QueueFull:
            pass   #That client is too slow; it gets the next status update instead

async def _status_loop():
    global latest_status
    while True:
        try:
            #GPIO and psutil reads block briefly, so run them off the event loop
            latest_status = await asyncio.to_thread(_read_status)
            _broadcast(_event('status', latest_status))
        except Exception as e:
            print(f'[-] Live API: status update failed: {e}')
        await asyncio.sleep(STATUS_INTERVAL_S)

def publish_detections(detections, inference_time, annotated_frame):
    """
    Send a detection event to connected clients. Called from the main loop after inference.

    :param detections: List from YoloTRT.Inference(), each with 'class' and 'conf'
    :param inference_time: Inference duration in seconds
    :param annotated_frame: The frame with bounding boxes drawn, shown briefly on the stream
    """
    global last_detection, detection_frame
    if not detections:
        return

    animals = sorted(
        ({'name': str(d['class']), 'confidence': round(float(d['conf']) * 100, 1)} for d in detections),
        key=lambda animal: animal['confidence'],
        reverse=True,
    )
    last_detection = {
        'animals': animals,
        'top': animals[0],
        'detected_at': _iso(),
        'inference_ms': round(inference_time * 1000, 1),
    }
    detection_frame = (annotated_frame.copy(), time.time())

    if event_loop is not None:
        event_loop.call_soon_threadsafe(_broadcast, _event('detection', last_detection))

#---------------- MJPEG stream ----------------
def _current_frame():
    """Newest frame to stream: the detection frame for a moment after a detection, else the camera frame."""
    if detection_frame is not None and time.time() - detection_frame[1] < DETECTION_FRAME_HOLD_S:
        return ('detection', detection_frame[1]), detection_frame[0]
    frame, frame_id, _ = camera.latest() if camera is not None else (None, 0, None)
    return ('camera', frame_id), frame

def _encode_jpeg(key, frame):
    #All stream viewers share one encoded copy of each frame
    if jpeg_cache['key'] != key:
        ok, jpeg = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
        if not ok:
            return None
        jpeg_cache['key'], jpeg_cache['jpeg'] = key, jpeg.tobytes()
    return jpeg_cache['jpeg']

async def _mjpeg_frames():
    last_key = None
    while True:
        key, frame = _current_frame()
        if frame is None or key == last_key:
            await asyncio.sleep(1 / MAX_STREAM_FPS)
            continue
        jpeg = await asyncio.to_thread(_encode_jpeg, key, frame)
        if jpeg is None:
            continue
        last_key = key
        yield (b'--frame\r\nContent-Type: image/jpeg\r\nContent-Length: '
               + str(len(jpeg)).encode() + b'\r\n\r\n' + jpeg + b'\r\n')
        await asyncio.sleep(1 / MAX_STREAM_FPS)

#---------------- FastAPI app ----------------
@asynccontextmanager
async def lifespan(app):
    global event_loop
    event_loop = asyncio.get_running_loop()
    psutil.cpu_percent(interval=None)   #The first reading is always 0, so take it now
    status_task = asyncio.create_task(_status_loop())
    yield
    status_task.cancel()

app = FastAPI(title='SmartGate Live API', lifespan=lifespan)

@app.get('/health')
async def health():
    return {'status': 'ok', 'camera': _camera_status()['status'], 'model_ready': model_info['ready']}

@app.get('/status')
async def status():
    return latest_status or await asyncio.to_thread(_read_status)

@app.get('/stream')
async def stream():
    return StreamingResponse(_mjpeg_frames(), media_type='multipart/x-mixed-replace; boundary=frame',
                             headers={'Cache-Control': 'no-store'})

@app.websocket('/ws/events')
async def events(websocket: WebSocket):
    await websocket.accept()
    queue = asyncio.Queue(maxsize=CLIENT_QUEUE_SIZE)
    clients.add(queue)
    try:
        snapshot = {'status': latest_status or await asyncio.to_thread(_read_status), 'detection': last_detection}
        await websocket.send_json(_event('snapshot', snapshot))
        while True:
            await websocket.send_json(await queue.get())
    except Exception:
        pass   #The client disconnected
    finally:
        clients.discard(queue)

#---------------- Start / stop ----------------
def start_live_api(server_config, camera_reader, door, pin_reader, model_config):
    """
    Start the live service on a background thread.

    :param server_config: "server" section of config.json; the service uses its "live_port"
    :param camera_reader: CameraReader providing the frames
    :param door: DoorControl used for the gate position
    :param pin_reader: Function reading a named GPIO input (io_control.get_val)
    :param model_config: "model" section of config.json
    :return: The uvicorn server, or None if "live_port" is not configured
    """
    global camera, door_controller, read_pin
    port = server_config.get('live_port')
    if not port:
        print('[!] Live API disabled: no "live_port" in the server configuration')
        return None

    camera, door_controller, read_pin = camera_reader, door, pin_reader
    model_info.update({
        'ready': True,
        'name': os.path.basename(model_config.get('path', '')) or None,
        'confidence_threshold': model_config.get('confidence'),
    })

    server = uvicorn.Server(uvicorn.Config(app, host='0.0.0.0', port=port, log_level='warning'))
    threading.Thread(target=server.run, daemon=True).start()
    print(f'[+] Live API running under port {port}')
    return server

def stop_live_api(server):
    if server is not None:
        print('[+] Shutting down the live API...')
        server.should_exit = True
