import threading
import time

#This class reads camera frames continuously on a background thread, so the live stream keeps
#updating while the gate is idle. The main loop takes its frames from here instead of reading
#the camera directly.

class CameraReader:
    """
    Continuously reads frames from a camera on a background thread.

    :param open_capture: Function returning an opened `cv2.VideoCapture`. It is called again to
                         reconnect if the camera stops delivering frames.
    :param reopen_after_s: Seconds without a frame before the camera is reopened
    """
    def __init__(self, open_capture, reopen_after_s=5.0):
        self.open_capture = open_capture
        self.reopen_after_s = reopen_after_s

        self.frame = None
        self.frame_id = 0
        self.last_frame_time = None
        self.fps = 0.0
        self.last_returned_id = 0

        self.condition = threading.Condition()
        self.running = True

        self.cap = self.open_capture()
        self.thread = threading.Thread(target=self._read_loop, daemon=True)
        self.thread.start()

    def _read_loop(self):
        last_ok = time.time()
        fps_count = 0
        fps_start = time.time()

        while self.running:
            ret_val, frame = self.cap.read() if self.cap.isOpened() else (False, None)
            now = time.time()

            if ret_val:
                with self.condition:
                    self.frame = frame
                    self.frame_id += 1
                    self.last_frame_time = now
                    self.condition.notify_all()
                last_ok = now

                #Measure the frame rate once per second
                fps_count += 1
                if now - fps_start >= 1.0:
                    self.fps = fps_count / (now - fps_start)
                    fps_count = 0
                    fps_start = now
            else:
                self.fps = 0.0
                time.sleep(0.5)
                if now - last_ok > self.reopen_after_s:
                    print('[-] Camera is not delivering frames. Reopening camera...')
                    self.cap.release()
                    self.cap = self.open_capture()
                    last_ok = time.time()

    def read(self, timeout=2.0):
        """
        Wait for a frame that has not been returned by `read()` before.

        :param timeout: Maximum seconds to wait for a new frame
        :return: (True, copy of the frame) or (False, None) if no new frame arrived in time
        """
        deadline = time.time() + timeout
        with self.condition:
            while self.frame_id == self.last_returned_id:
                remaining = deadline - time.time()
                if remaining <= 0:
                    return False, None
                self.condition.wait(remaining)
            self.last_returned_id = self.frame_id
            #Copy, because detection draws bounding boxes onto the frame it is given
            return True, self.frame.copy()

    def latest(self):
        """
        Get the newest frame without waiting. The frame must not be modified.

        :return: (frame or None, frame id, time of the frame or None)
        """
        with self.condition:
            return self.frame, self.frame_id, self.last_frame_time

    def release(self):
        """Stop reading and release the camera."""
        self.running = False
        self.thread.join(timeout=2.0)
        self.cap.release()
