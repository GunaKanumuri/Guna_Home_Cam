"""
iCMOB AI Monitor v6 — Final Production Build
---------------------------------------------
Guna's home · 3 CP Plus cameras · DVR at 192.168.0.100
Stack: ffmpeg (RTSP) · Gemini Vision AI · Ntfy push · optional Telegram

COMPLETE VERSION HISTORY
════════════════════════
v3 → original working script
  - 3-camera RTSP grab via ffmpeg
  - Gemini vision analysis with structured prompt
  - Ntfy + Telegram notifications
  - Motion detection via numpy pixel diff
  - Event log (jsonl) + snapshot storage
  - Daily summary, cleanup, active hours

v4 → bug fixes
  [fix] Removed duplicate _build_notification_body definition
  [fix] Daily summary fires at actual midnight, not 24h after startup
  [fix] cleanup_old_snapshots() called once at startup too
  [fix] Temp snap file deleted after loading (no corrupt-read on next cycle)
  [fix] Motion state resets only after 3 consecutive failures (not 1)
  [fix] ACTIVE_HOURS end boundary inclusive — (6,23) runs through 23:59
  [fix] Intruder prompt fixed — family at night no longer triggers urgent alert
  [fix] Per-event-type cooldown dict — package won't be suppressed by person alert
  [fix] Gemini retries once with backoff on timeout or 429
  [fix] Notifications fire in thread pool — never blocks camera loop
  [fix] Scan interval accounts for processing time — true 15s gap
  [fix] Gemini startup ping validates key + model before watchers launch
  [fix] API key / RTSP credentials read from env vars first

v5 → operational hardening
  [fix] Event log trimmed to 90 days — won't grow forever
  [fix] Disk space check at startup + nightly Ntfy warning if < 500 MB free
  [fix] Watcher thread health monitor — dead threads auto-restarted
  [fix] Exponential backoff on repeated RTSP failures (DVR reboot handling)
  [fix] Gemini fallback model — auto-retries with gemini-1.5-flash on 404
  [new] --test-cam CLI flag — grab frame, run Gemini, print result
  [new] Per-camera motion_threshold in camera config dict
  [new] Night-mode IR transition detection — threshold raised at dusk/dawn

v6 → all 11 gaps from v5 fixed (THIS VERSION)
  [fix-1]  events.jsonl protected by a threading.Lock — no concurrent write corruption
  [fix-2]  save_snapshot checks free disk before writing — skips + warns if < MIN_FREE_DISK_MB
  [fix-3]  trim_event_log rewrites via temp file line-by-line — no full RAM load on large files
  [fix-4]  Thread restart preserves cooldown state — restarted watcher inherits _last_alert_ts
  [fix-5]  Startup Ntfy notification — "iCMOB started, 3 cameras live"
  [fix-6]  send_daily_summary early-exits if NTFY_ENABLED is False
  [fix-7]  Motion score used in notification — shown in body if score >= 2× threshold
  [fix-8]  _is_night() computed once per frame and passed through — no clock-flip at 22:00:00
  [fix-9]  Camera pause via pause file — touch ~/icmob_ai/pause_cam1 to silence that camera
  [fix-10] Log rotation via RotatingFileHandler — 5 MB max, 3 backups, never grows unbounded
  [fix-11] Quiet-day summary — sends "System running fine, quiet day" if zero notable events

Dependencies: requests pillow numpy ffmpeg (system)
"""

import io, os, sys, time, base64, logging, json, shutil, argparse, tempfile
import requests, numpy as np, subprocess
from PIL          import Image
from datetime     import datetime, timedelta
from threading    import Thread, Lock
from concurrent.futures import ThreadPoolExecutor
from logging.handlers   import RotatingFileHandler

HOME     = os.path.expanduser("~")
BASE_DIR = os.path.join(HOME, "icmob_ai")

# ═══════════════════════════════════════════════════════════════════════
#  CONFIG  ── only edit this block
# ═══════════════════════════════════════════════════════════════════════

CAMERAS = [
    {
        "id":               "cam1",
        "name":             "Main Gate",
        "location":         "ground floor main gate and street entrance of the house",
        "rtsp_url":         os.getenv("RTSP_CAM1", "rtsp://admin:1234567a@192.168.0.100:554/cam/realmonitor?channel=1&subtype=0"),
        "enabled":          True,
        "motion_threshold": 10.0,   # street-facing — higher to ignore traffic/wind
    },
    {
        "id":               "cam2",
        "name":             "Ground Floor",
        "location":         "ground floor front door and staircase going up to first floor",
        "rtsp_url":         os.getenv("RTSP_CAM2", "rtsp://admin:1234567a@192.168.0.100:554/cam/realmonitor?channel=2&subtype=0"),
        "enabled":          True,
        "motion_threshold": 8.0,
    },
    {
        "id":               "cam3",
        "name":             "First Floor",
        "location":         "first floor main door, balcony, and staircase going up to second floor",
        "rtsp_url":         os.getenv("RTSP_CAM3", "rtsp://admin:1234567a@192.168.0.100:554/cam/realmonitor?channel=3&subtype=0"),
        "enabled":          True,
        "motion_threshold": 7.0,    # indoor — lower, very little background noise
    },
]

GEMINI_API_KEY        = os.getenv("GEMINI_API_KEY", "your_gemini_api_key_here")
GEMINI_MODEL          = "gemini-2.5-flash-lite-preview-06-17"
GEMINI_MODEL_FALLBACK = "gemini-1.5-flash"   # auto-used if primary returns 404

NTFY_ENABLED          = True
NTFY_SERVER           = "https://ntfy.sh"
NTFY_TOPIC            = "guna-home-cams"

TELEGRAM_ENABLED      = False
TELEGRAM_BOT_TOKEN    = os.getenv("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID      = os.getenv("TELEGRAM_CHAT_ID", "")

SCAN_INTERVAL_SEC       = 15     # true gap between grabs — processing time excluded
MIN_ALERT_GAP_SEC       = 60     # cooldown per event type per camera
MOTION_RESET_FAIL_COUNT = 3      # consecutive failures before motion state wipes
ACTIVE_HOURS            = (6, 23)  # inclusive — 06:00 to 23:59 | None = 24/7
SNAPSHOT_KEEP_DAYS      = 2      # snapshots deleted after 2 days
EVENT_LOG_KEEP_DAYS     = 90     # event log entries kept for 90 days (DVR reference)
MIN_FREE_DISK_MB        = 500    # Ntfy warning + skip snapshot if below this
THREAD_CHECK_INTERVAL   = 120    # seconds between watcher health checks
BACKOFF_STEPS_SEC       = [15, 30, 60, 120]  # RTSP failure backoff, caps at 120s

LOG_DIR        = os.path.join(BASE_DIR, "logs")
EVENT_LOG_FILE = os.path.join(BASE_DIR, "logs", "events.jsonl")
SNAP_BASE_DIR  = os.path.join(BASE_DIR, "snapshots")
MAX_IMAGE_SIZE = (640, 480)
JPEG_QUALITY   = 70

EVENT_CONFIG = {
    "person_detected":   {"alert": True,  "priority": "high",   "emoji": "bust_in_silhouette", "ntfy_priority": 4},
    "intruder_detected": {"alert": True,  "priority": "urgent", "emoji": "rotating_light",     "ntfy_priority": 5},
    "package_detected":  {"alert": True,  "priority": "medium", "emoji": "package",            "ntfy_priority": 3},
    "vehicle_detected":  {"alert": True,  "priority": "medium", "emoji": "car",                "ntfy_priority": 3},
    "animal_detected":   {"alert": True,  "priority": "low",    "emoji": "paw_prints",         "ntfy_priority": 2},
    "unknown_activity":  {"alert": True,  "priority": "medium", "emoji": "eyes",               "ntfy_priority": 3},
    "nothing_notable":   {"alert": False, "priority": "low",    "emoji": "white_check_mark",   "ntfy_priority": 1},
}

# ═══════════════════════════════════════════════════════════════════════
#  LOGGING  ── [fix-10] RotatingFileHandler — 5 MB max, 3 backups
# ═══════════════════════════════════════════════════════════════════════

os.makedirs(LOG_DIR,       exist_ok=True)
os.makedirs(BASE_DIR,      exist_ok=True)
os.makedirs(SNAP_BASE_DIR, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        RotatingFileHandler(
            os.path.join(LOG_DIR, "monitor.log"),
            maxBytes=5 * 1024 * 1024,   # 5 MB per file
            backupCount=3               # keep monitor.log + 3 rotated backups
        ),
        logging.StreamHandler()
    ]
)
log = logging.getLogger(__name__)

_notify_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="notify")

# ═══════════════════════════════════════════════════════════════════════
#  FRAME GRABBER — ffmpeg over RTSP
# ═══════════════════════════════════════════════════════════════════════

def grab_frame(camera: dict) -> Image.Image | None:
    tmp = os.path.join(BASE_DIR, f"snap_{camera['id']}.jpg")
    try:
        cmd = [
            "ffmpeg", "-y",
            "-rtsp_transport", "tcp",
            "-i", camera["rtsp_url"],
            "-vframes", "1",
            "-update", "1",
            "-q:v", "5",
            tmp
        ]
        proc = subprocess.run(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=15
        )
        if proc.returncode == 0 and os.path.exists(tmp):
            img = Image.open(tmp).convert("RGB")
            img.thumbnail(MAX_IMAGE_SIZE)
            try:
                os.remove(tmp)
            except OSError:
                pass
            return img

        log.warning(f"[{camera['name']}] ffmpeg failed (code {proc.returncode})")
        return None

    except subprocess.TimeoutExpired:
        log.warning(f"[{camera['name']}] ffmpeg timed out")
        return None
    except Exception as e:
        log.error(f"[{camera['name']}] grab_frame error: {e}")
        return None

# ═══════════════════════════════════════════════════════════════════════
#  MOTION DETECTION — pixel diff + IR night detection
# ═══════════════════════════════════════════════════════════════════════

_prev_frames: dict[str, np.ndarray] = {}
_fail_counts: dict[str, int]        = {}
_ir_mode:     dict[str, bool]       = {}
_ir_lock      = Lock()

def _is_ir_mode(img: Image.Image) -> bool:
    """
    Detect IR night mode — B&W cameras show near-zero channel deviation.
    Max mean channel diff < 8 across the resized frame = monochrome/IR.
    """
    arr = np.array(img.resize((80, 60)), dtype=np.float32)
    r, g, b  = arr[:,:,0], arr[:,:,1], arr[:,:,2]
    max_diff = float(np.max([
        np.mean(np.abs(r - g)),
        np.mean(np.abs(g - b)),
        np.mean(np.abs(r - b)),
    ]))
    return max_diff < 8.0

def detect_motion(cam_id: str, img: Image.Image, threshold: float) -> tuple[bool, float]:
    """
    Per-camera threshold. IR transition frames are skipped and threshold is
    raised 40% during IR mode to absorb dusk/dawn pixel spikes.
    """
    gray = np.array(img.convert("L").resize((160, 120)), dtype=np.float32)
    _fail_counts[cam_id] = 0

    with _ir_lock:
        currently_ir  = _is_ir_mode(img)
        was_ir        = _ir_mode.get(cam_id, currently_ir)
        transitioning = currently_ir != was_ir
        _ir_mode[cam_id] = currently_ir

    if transitioning:
        _prev_frames.pop(cam_id, None)
        mode_label = "night (IR)" if currently_ir else "day (colour)"
        log.info(f"[{cam_id}] Switched to {mode_label} — skipping transition frame")
        return False, 0.0

    effective_threshold = threshold * 1.4 if currently_ir else threshold

    if cam_id not in _prev_frames:
        _prev_frames[cam_id] = gray
        return False, 0.0

    score = float(np.mean(np.abs(gray - _prev_frames[cam_id])))
    _prev_frames[cam_id] = gray
    return score > effective_threshold, round(score, 2)

def increment_fail(cam_id: str):
    """Wipe motion state only after MOTION_RESET_FAIL_COUNT consecutive failures."""
    _fail_counts[cam_id] = _fail_counts.get(cam_id, 0) + 1
    if _fail_counts[cam_id] >= MOTION_RESET_FAIL_COUNT:
        _prev_frames.pop(cam_id, None)
        _fail_counts[cam_id] = 0
        log.info(f"[{cam_id}] Motion state reset after {MOTION_RESET_FAIL_COUNT} failures")

# ═══════════════════════════════════════════════════════════════════════
#  GEMINI AI ANALYZER
# ═══════════════════════════════════════════════════════════════════════

_active_gemini_model = GEMINI_MODEL
_gemini_model_lock   = Lock()

def _build_prompt(camera: dict, is_night: bool) -> str:
    """
    [fix-8] is_night passed in — computed once per frame, never flips mid-call.
    """
    time_context = "at night (be extra alert for intruders)" if is_night else "during the day"
    return f"""You are an intelligent home security AI for an Indian home in Hyderabad.
This camera covers the {camera['location']}.
The time is {time_context}.

Look carefully at the image and respond in EXACTLY this format — no extra text, no explanation:

EVENT: [person_detected | intruder_detected | package_detected | vehicle_detected | animal_detected | unknown_activity | nothing_notable]
ALERT: [yes | no]
SUMMARY: [describe what you see in plain English, max 15 words]
PERSON: [describe the person if visible, otherwise write: none]
PRIORITY: [urgent | high | medium | low]
CONFIDENCE: [0-100]

Rules for EVENT:
- person_detected: any person — family member, visitor, delivery person
- intruder_detected: unknown person acting SUSPICIOUSLY after 10pm — jumping walls, hiding, lurking, or behaving abnormally. Do NOT classify normal movement (walking, entering gate) as intruder even at night.
- package_detected: parcel, box, bag, delivery item left at door
- vehicle_detected: car, bike, auto, truck near gate or driveway
- animal_detected: dog, cat, cow, bird, rat etc
- unknown_activity: something changed but unclear what
- nothing_notable: empty scene, no people or activity

Rules for ALERT:
- ALERT=yes for: person, intruder, package, vehicle, unknown_activity
- ALERT=no for: nothing_notable, animal (unless inside house at night)
- PRIORITY=urgent only for intruder showing suspicious behaviour

Rules for SUMMARY:
- Plain English sentence, max 15 words
- Examples: "An elderly woman is entering through the main gate"
- Examples: "A parcel is left near the front door"
- If dark/blurry: "Image is dark, a figure is visible near the gate"

Rules for PERSON — only if person visible, else write: none
- Gender + clothing colour + type only, max 6 words
- Day: "woman in green saree" / "man in red shirt" / "man in white kurta"
- Night B&W: "woman in light coloured saree" / "man in dark shirt"
- Unclear: "person visible, clothing unclear" """

def _call_gemini_model(model: str, camera: dict, img: Image.Image, is_night: bool) -> dict | None:
    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/"
        f"{model}:generateContent?key={GEMINI_API_KEY}"
    )
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=JPEG_QUALITY)
    img_b64 = base64.b64encode(buf.getvalue()).decode()

    payload = {
        "contents": [{"parts": [
            {"text": _build_prompt(camera, is_night)},
            {"inline_data": {"mime_type": "image/jpeg", "data": img_b64}}
        ]}],
        "generationConfig": {"maxOutputTokens": 150, "temperature": 0.1}
    }

    r = requests.post(
        url, json=payload,
        headers={"Content-Type": "application/json"},
        timeout=15
    )

    if r.status_code == 429:
        raise requests.exceptions.ConnectionError("rate_limited")
    if r.status_code == 404:
        raise requests.exceptions.ConnectionError("model_not_found")
    if r.status_code != 200:
        log.error(f"Gemini error {r.status_code}: {r.text[:150]}")
        return None

    text   = r.json()["candidates"][0]["content"]["parts"][0]["text"].strip()
    result = {}
    for line in text.splitlines():
        if ":" in line:
            k, _, v = line.partition(":")
            result[k.strip().upper()] = v.strip()

    if "EVENT" not in result:
        log.warning(f"Unexpected Gemini response: {text}")
        return None

    try:
        result["CONFIDENCE"] = int(result.get("CONFIDENCE", "0"))
    except ValueError:
        result["CONFIDENCE"] = 0

    result.setdefault("PERSON", "none")
    return result

def analyze(camera: dict, img: Image.Image, is_night: bool) -> dict | None:
    """
    [fix-8] Accepts pre-computed is_night — no clock-flip risk.
    Retries once on timeout/429. Auto-falls back to GEMINI_MODEL_FALLBACK on 404.
    """
    global _active_gemini_model

    for attempt in range(2):
        try:
            with _gemini_model_lock:
                model = _active_gemini_model
            return _call_gemini_model(model, camera, img, is_night)

        except requests.exceptions.Timeout:
            if attempt == 0:
                log.warning(f"[{camera['name']}] Gemini timeout — retrying in 3s")
                time.sleep(3)
            else:
                log.error(f"[{camera['name']}] Gemini timeout on retry — dropping frame")
                return None

        except requests.exceptions.ConnectionError as e:
            err = str(e)
            if "model_not_found" in err:
                with _gemini_model_lock:
                    if _active_gemini_model != GEMINI_MODEL_FALLBACK:
                        log.warning(f"Model '{_active_gemini_model}' not found — switching to {GEMINI_MODEL_FALLBACK}")
                        _active_gemini_model = GEMINI_MODEL_FALLBACK
                try:
                    return _call_gemini_model(GEMINI_MODEL_FALLBACK, camera, img, is_night)
                except Exception as fe:
                    log.error(f"Fallback model also failed: {fe}")
                    return None
            elif "rate_limited" in err and attempt == 0:
                log.warning(f"[{camera['name']}] Gemini 429 — retrying in 5s")
                time.sleep(5)
            else:
                log.error(f"[{camera['name']}] Gemini connection error — dropping frame")
                return None

        except Exception as e:
            log.error(f"[{camera['name']}] Gemini error: {e}")
            return None

    return None

def ping_gemini() -> bool:
    """Startup check — validates key + model. Switches to fallback if primary 404s."""
    global _active_gemini_model
    for model in [GEMINI_MODEL, GEMINI_MODEL_FALLBACK]:
        try:
            url = (
                f"https://generativelanguage.googleapis.com/v1beta/models/"
                f"{model}:generateContent?key={GEMINI_API_KEY}"
            )
            r = requests.post(
                url,
                json={"contents": [{"parts": [{"text": "Say OK"}]}],
                      "generationConfig": {"maxOutputTokens": 5}},
                headers={"Content-Type": "application/json"},
                timeout=10
            )
            if r.status_code == 200:
                with _gemini_model_lock:
                    _active_gemini_model = model
                log.info(f"✅ Gemini verified — model: {model}")
                return True
            elif r.status_code == 404 and model == GEMINI_MODEL:
                log.warning(f"Primary model '{model}' not found — trying fallback...")
                continue
            else:
                log.error(f"❌ Gemini ping failed ({model}): {r.status_code}")
                return False
        except Exception as e:
            log.error(f"❌ Gemini ping error ({model}): {e}")
            if model == GEMINI_MODEL:
                continue
            return False
    log.error("❌ Both Gemini models failed")
    return False

# ═══════════════════════════════════════════════════════════════════════
#  DISK SPACE
# ═══════════════════════════════════════════════════════════════════════

def check_disk_space(warn: bool = True) -> float:
    """Returns free MB. Ntfy warning if below MIN_FREE_DISK_MB."""
    try:
        free_mb = shutil.disk_usage(BASE_DIR).free / (1024 * 1024)
        if warn and free_mb < MIN_FREE_DISK_MB:
            msg = f"⚠️ Low disk: {free_mb:.0f} MB free (min {MIN_FREE_DISK_MB} MB)"
            log.warning(msg)
            if NTFY_ENABLED:
                try:
                    requests.post(f"{NTFY_SERVER}/{NTFY_TOPIC}", headers={
                        "Title": "iCMOB — Low Disk Space",
                        "Tags": "warning", "Priority": "4", "Message": msg,
                    }, timeout=10)
                except Exception:
                    pass
        return free_mb
    except Exception as e:
        log.error(f"Disk check error: {e}")
        return 9999.0

# ═══════════════════════════════════════════════════════════════════════
#  NOTIFICATIONS
# ═══════════════════════════════════════════════════════════════════════

def _build_notification_body(camera: dict, result: dict, motion_score: float) -> str:
    """
    [fix-7] Motion score included in notification when significantly above threshold.
    High score (2× threshold) means fast/large movement — worth knowing.
    """
    summary   = result.get("SUMMARY", "Activity detected")
    conf      = result.get("CONFIDENCE", 0)
    priority  = result.get("PRIORITY", "medium").lower()
    threshold = camera.get("motion_threshold", 8.0)

    body = summary
    if conf >= 70:
        body += f" ({conf}% sure)"
    elif conf > 0:
        body += f" (~{conf}% sure)"

    # High motion score — signals fast movement like running
    if motion_score >= threshold * 2:
        body += f" [fast movement, score {motion_score}]"

    if priority == "urgent":
        body = "🚨 URGENT: " + body

    return body

def _send_ntfy(camera: dict, result: dict, img: Image.Image | None, motion_score: float):
    if not NTFY_ENABLED:
        return
    event   = result.get("EVENT", "unknown_activity")
    cfg     = EVENT_CONFIG.get(event, EVENT_CONFIG["unknown_activity"])
    body    = _build_notification_body(camera, result, motion_score)
    headers = {
        "Title":    camera["name"],
        "Tags":     cfg["emoji"],
        "Priority": str(cfg["ntfy_priority"]),
        "Message":  body,
    }
    try:
        if img:
            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=80)
            buf.seek(0)
            requests.put(
                f"{NTFY_SERVER}/{NTFY_TOPIC}",
                data=buf,
                headers={**headers, "Filename": "snapshot.jpg"},
                timeout=10
            )
        else:
            requests.post(f"{NTFY_SERVER}/{NTFY_TOPIC}", headers=headers, timeout=10)
        log.info(f"Ntfy → [{camera['name']}] {body}")
    except Exception as e:
        log.error(f"Ntfy error: {e}")

def _send_telegram(camera: dict, result: dict, img: Image.Image | None, motion_score: float):
    if not TELEGRAM_ENABLED:
        return
    body = _build_notification_body(camera, result, motion_score)
    text = f"📍 *{camera['name']}*\n{body}"
    try:
        base = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}"
        if img:
            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=80)
            buf.seek(0)
            requests.post(
                f"{base}/sendPhoto",
                data={"chat_id": TELEGRAM_CHAT_ID, "caption": text, "parse_mode": "Markdown"},
                files={"photo": ("snapshot.jpg", buf, "image/jpeg")},
                timeout=15
            )
        else:
            requests.post(
                f"{base}/sendMessage",
                json={"chat_id": TELEGRAM_CHAT_ID, "text": text, "parse_mode": "Markdown"},
                timeout=10
            )
        log.info(f"Telegram → [{camera['name']}] sent")
    except Exception as e:
        log.error(f"Telegram error: {e}")

def send_all_notifications(camera: dict, result: dict,
                           img: Image.Image | None, motion_score: float):
    event = result.get("EVENT", "")
    cfg   = EVENT_CONFIG.get(event, {})
    if not cfg.get("alert", False):
        return
    if result.get("ALERT", "no").lower() != "yes":
        return
    _notify_executor.submit(_send_ntfy,     camera, result, img, motion_score)
    _notify_executor.submit(_send_telegram, camera, result, img, motion_score)

def _ntfy_simple(title: str, message: str, tags: str = "bell", priority: str = "2"):
    """Fire-and-forget Ntfy for system messages."""
    if not NTFY_ENABLED:
        return
    try:
        requests.post(f"{NTFY_SERVER}/{NTFY_TOPIC}", headers={
            "Title": title, "Tags": tags,
            "Priority": priority, "Message": message,
        }, timeout=8)
    except Exception:
        pass

# ═══════════════════════════════════════════════════════════════════════
#  STORAGE — event log + snapshots
# ═══════════════════════════════════════════════════════════════════════

_event_log_lock = Lock()   # [fix-1] protects concurrent writes to events.jsonl

def save_event(camera: dict, result: dict, motion_score: float, is_night: bool) -> str:
    """[fix-1] Lock around file append — safe when multiple threads fire simultaneously."""
    now      = datetime.now()
    event_id = f"{camera['id']}_{int(now.timestamp())}"
    record   = {
        "event_id":     event_id,
        "timestamp":    now.isoformat(),
        "camera_id":    camera["id"],
        "camera_name":  camera["name"],
        "event":        result.get("EVENT", ""),
        "alert":        result.get("ALERT", "no"),
        "summary":      result.get("SUMMARY", ""),
        "person":       result.get("PERSON", "none"),
        "priority":     result.get("PRIORITY", "low"),
        "confidence":   result.get("CONFIDENCE", 0),
        "motion_score": motion_score,
        "night":        is_night,
    }
    try:
        with _event_log_lock:
            with open(EVENT_LOG_FILE, "a") as f:
                f.write(json.dumps(record) + "\n")
    except Exception as e:
        log.error(f"save_event error: {e}")
    return event_id

def save_snapshot(camera: dict, img: Image.Image, event_id: str):
    """
    [fix-2] Check free disk before writing.
    Skips snapshot and logs warning if disk is too full.
    Event log entry still exists for DVR playback reference.
    """
    free_mb = check_disk_space(warn=False)
    if free_mb < MIN_FREE_DISK_MB:
        log.warning(
            f"[{camera['name']}] Snapshot skipped — only {free_mb:.0f} MB free "
            f"(min {MIN_FREE_DISK_MB} MB). Use DVR playback for this event."
        )
        return
    try:
        cam_dir = os.path.join(SNAP_BASE_DIR, camera["id"])
        os.makedirs(cam_dir, exist_ok=True)
        img.save(os.path.join(cam_dir, f"{event_id}.jpg"), format="JPEG", quality=85)
    except Exception as e:
        log.error(f"save_snapshot error: {e}")

def cleanup_old_snapshots():
    """Delete snapshots older than SNAPSHOT_KEEP_DAYS days."""
    cutoff = time.time() - (SNAPSHOT_KEEP_DAYS * 86400)
    count  = 0
    for root, _, files in os.walk(SNAP_BASE_DIR):
        for f in files:
            fp = os.path.join(root, f)
            try:
                if os.path.getmtime(fp) < cutoff:
                    os.remove(fp)
                    count += 1
            except Exception:
                pass
    if count:
        log.info(f"Cleaned {count} snapshots older than {SNAPSHOT_KEEP_DAYS}d")

def trim_event_log():
    """
    [fix-3] Line-by-line rewrite via temp file — never loads full log into RAM.
    Safe on low-memory devices even after months of events.
    """
    if not os.path.exists(EVENT_LOG_FILE):
        return
    cutoff  = (datetime.now() - timedelta(days=EVENT_LOG_KEEP_DAYS)).isoformat()
    kept    = 0
    dropped = 0
    tmp_path = EVENT_LOG_FILE + ".tmp"
    try:
        with open(EVENT_LOG_FILE) as src, open(tmp_path, "w") as dst:
            for line in src:
                try:
                    e = json.loads(line)
                    if e.get("timestamp", "") >= cutoff:
                        dst.write(line)
                        kept += 1
                    else:
                        dropped += 1
                except Exception:
                    dst.write(line)   # keep malformed lines

        if dropped:
            os.replace(tmp_path, EVENT_LOG_FILE)   # atomic on same filesystem
            log.info(f"Event log trimmed: {dropped} removed, {kept} kept")
        else:
            os.remove(tmp_path)
    except Exception as e:
        log.error(f"trim_event_log error: {e}")
        try:
            os.remove(tmp_path)
        except Exception:
            pass

# ═══════════════════════════════════════════════════════════════════════
#  CAMERA PAUSE — [fix-9]
# ═══════════════════════════════════════════════════════════════════════

def _pause_file(cam_id: str) -> str:
    return os.path.join(BASE_DIR, f"pause_{cam_id}")

def is_paused(cam_id: str) -> bool:
    """
    [fix-9] Touch ~/icmob_ai/pause_cam1 to silence cam1.
    Remove the file to resume. No restart needed.
    Notifications are suppressed but events are still logged.
    """
    return os.path.exists(_pause_file(cam_id))

# ═══════════════════════════════════════════════════════════════════════
#  DAILY SUMMARY — [fix-6] [fix-11]
# ═══════════════════════════════════════════════════════════════════════

def _format_time_12h(iso_ts: str) -> str:
    try:
        return datetime.fromisoformat(iso_ts).strftime("%-I:%M %p").lower()
    except Exception:
        return ""

def send_daily_summary():
    """
    [fix-6] Early exit if NTFY_ENABLED is False — no pointless log scan.
    [fix-11] Sends "quiet day" confirmation even when zero notable events,
             so silence in notifications still confirms the system ran.
    Timeline example: "man in red shirt at 10:20 am (Main Gate)"
    """
    if not NTFY_ENABLED:
        return

    today  = datetime.now().date().isoformat()
    total  = persons = intruders = packages = vehicles = 0
    notable_events: list[dict] = []

    if os.path.exists(EVENT_LOG_FILE):
        try:
            with open(EVENT_LOG_FILE) as f:
                for line in f:
                    try:
                        e = json.loads(line)
                        if not e.get("timestamp", "").startswith(today):
                            continue
                        total += 1
                        evt = e.get("event", "")
                        t12 = _format_time_12h(e.get("timestamp", ""))

                        if evt == "person_detected":
                            persons += 1
                            desc = e.get("person", "none")
                            notable_events.append({
                                "time": t12,
                                "label": desc if desc != "none" else "person",
                                "cam": e.get("camera_name", "")
                            })
                        elif evt == "intruder_detected":
                            intruders += 1
                            notable_events.append({"time": t12, "label": "⚠️ intruder", "cam": e.get("camera_name", "")})
                        elif evt == "package_detected":
                            packages += 1
                            notable_events.append({"time": t12, "label": "delivery/package", "cam": e.get("camera_name", "")})
                        elif evt == "vehicle_detected":
                            vehicles += 1
                            notable_events.append({"time": t12, "label": "vehicle", "cam": e.get("camera_name", "")})
                    except Exception:
                        continue
        except Exception as e:
            log.error(f"Daily summary read error: {e}")

    # [fix-11] Always send — quiet day is worth confirming
    if total == 0:
        _ntfy_simple(
            f"Daily Summary — {today}",
            "Quiet day — no motion events detected. System running fine.",
            tags="white_check_mark"
        )
        log.info("Daily summary: quiet day")
        return

    count_parts = [f"{total} events"]
    if persons:   count_parts.append(f"{persons} people")
    if intruders: count_parts.append(f"{intruders} intruders ⚠️")
    if packages:  count_parts.append(f"{packages} packages")
    if vehicles:  count_parts.append(f"{vehicles} vehicles")
    counts_line = ", ".join(count_parts)

    timeline_parts = []
    for ev in notable_events[:10]:
        entry = (f"{ev['label']} at {ev['time']} ({ev['cam']})"
                 if ev["time"] else f"{ev['label']} ({ev['cam']})")
        timeline_parts.append(entry)

    body = counts_line
    if timeline_parts:
        body += "\n" + " • ".join(timeline_parts)

    try:
        requests.post(f"{NTFY_SERVER}/{NTFY_TOPIC}", headers={
            "Title":    f"Daily Summary — {today}",
            "Tags":     "bar_chart",
            "Priority": "2",
            "Message":  body,
        }, timeout=10)
        log.info(f"Daily summary: {counts_line}")
    except Exception as e:
        log.error(f"Daily summary send error: {e}")

# ═══════════════════════════════════════════════════════════════════════
#  BACKGROUND TASKS
# ═══════════════════════════════════════════════════════════════════════

def _seconds_until_midnight() -> float:
    now      = datetime.now()
    midnight = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    return (midnight - now).total_seconds()

def background_tasks():
    """Fires at actual midnight every day — cleanup, trim, disk check, summary."""
    wait = _seconds_until_midnight()
    log.info(f"Daily tasks scheduled in {wait/3600:.1f}h (midnight)")
    time.sleep(wait)
    while True:
        try:
            cleanup_old_snapshots()
            trim_event_log()
            check_disk_space(warn=True)
            send_daily_summary()
        except Exception as e:
            log.error(f"Background task error: {e}")
        time.sleep(86400)

# ═══════════════════════════════════════════════════════════════════════
#  ACTIVE HOURS
# ═══════════════════════════════════════════════════════════════════════

def _is_active_hour() -> bool:
    if ACTIVE_HOURS is None:
        return True
    h = datetime.now().hour
    return ACTIVE_HOURS[0] <= h <= ACTIVE_HOURS[1]

# ═══════════════════════════════════════════════════════════════════════
#  CAMERA WATCHER
# ═══════════════════════════════════════════════════════════════════════

class CameraWatcher:
    def __init__(self, camera: dict,
                 inherit_cooldown: dict[str, float] | None = None):
        """
        [fix-4] inherit_cooldown — when health monitor restarts a dead watcher,
        it passes the previous instance's _last_alert_ts so cooldown state
        is preserved across restarts. No double-alerts after a crash.
        """
        self.camera            = camera
        self.name              = camera["name"]
        self.id                = camera["id"]
        self.threshold         = camera.get("motion_threshold", 8.0)
        self.frame_count       = 0
        self.alert_count       = 0
        self.consecutive_fails = 0
        self._last_alert_ts: dict[str, float] = inherit_cooldown or {}

    def cooldown_snapshot(self) -> dict[str, float]:
        """Returns a copy of current cooldown state for the health monitor to pass to the replacement."""
        return dict(self._last_alert_ts)

    def _can_alert(self, event: str) -> bool:
        return time.time() - self._last_alert_ts.get(event, 0) >= MIN_ALERT_GAP_SEC

    def _mark_alerted(self, event: str):
        self._last_alert_ts[event] = time.time()

    def _backoff_sleep(self):
        idx  = min(self.consecutive_fails - 1, len(BACKOFF_STEPS_SEC) - 1)
        wait = BACKOFF_STEPS_SEC[idx]
        if self.consecutive_fails == 1 or self.consecutive_fails % 5 == 0:
            log.warning(f"[{self.name}] {self.consecutive_fails} consecutive RTSP failures — backoff {wait}s")
        time.sleep(wait)

    def _process(self, img: Image.Image, is_night: bool):
        """[fix-8] is_night passed in — computed once per loop iteration."""
        self.frame_count += 1

        motion, score = detect_motion(self.id, img, self.threshold)
        if not motion:
            return

        log.info(f"[{self.name}] Motion score {score} — calling Gemini...")

        result = analyze(self.camera, img, is_night)
        if not result:
            return

        event    = result.get("EVENT", "")
        summary  = result.get("SUMMARY", "")
        conf     = result.get("CONFIDENCE", 0)
        priority = result.get("PRIORITY", "low")

        log.info(f"[{self.name}] {event} | {priority} | conf={conf}% | score={score} | {summary}")

        event_id = save_event(self.camera, result, score, is_night)
        save_snapshot(self.camera, img, event_id)

        if result.get("ALERT", "no").lower() != "yes":
            return

        # Confidence floor per event type
        min_conf = 55
        if event == "intruder_detected":
            min_conf = 70
        elif event == "unknown_activity":
            min_conf = 65

        if conf < min_conf:
            log.info(f"[{self.name}] Confidence {conf}% too low for {event} (need {min_conf}%) — skipped")
            return

        if event == "unknown_activity" and not is_night:
            log.info(f"[{self.name}] Daytime unknown_activity skipped (shadows/wind)")
            return

        # [fix-9] Pause check — events still logged, just no notification
        if is_paused(self.id):
            log.info(f"[{self.name}] Paused — notification suppressed (event logged)")
            return

        if self._can_alert(event):
            send_all_notifications(self.camera, result, img, score)
            self._mark_alerted(event)
            self.alert_count += 1
        else:
            remaining = int(MIN_ALERT_GAP_SEC - (time.time() - self._last_alert_ts.get(event, 0)))
            log.info(f"[{self.name}] Cooldown for {event} — {remaining}s left")

    def run(self):
        log.info(f"[{self.name}] Watcher started (threshold={self.threshold})")
        while True:
            try:
                if not _is_active_hour():
                    time.sleep(30)
                    continue

                loop_start = time.time()
                is_night   = datetime.now().hour >= 22 or datetime.now().hour < 6  # [fix-8] once per loop
                img        = grab_frame(self.camera)

                if img is None:
                    self.consecutive_fails += 1
                    increment_fail(self.id)
                    self._backoff_sleep()
                    continue

                self.consecutive_fails = 0
                self._process(img, is_night)

                elapsed   = time.time() - loop_start
                time.sleep(max(0, SCAN_INTERVAL_SEC - elapsed))

            except KeyboardInterrupt:
                break
            except Exception as e:
                log.error(f"[{self.name}] Unexpected error: {e} — retrying in 10s")
                time.sleep(10)

        log.info(f"[{self.name}] Stopped. frames={self.frame_count} alerts={self.alert_count}")

# ═══════════════════════════════════════════════════════════════════════
#  THREAD HEALTH MONITOR — [fix-4] preserves cooldown on restart
# ═══════════════════════════════════════════════════════════════════════

_watcher_instances: dict[str, CameraWatcher] = {}
_watcher_threads:   dict[str, Thread]        = {}
_watcher_lock = Lock()

def _spawn_watcher(cam: dict,
                   inherit_cooldown: dict[str, float] | None = None) -> tuple[CameraWatcher, Thread]:
    watcher = CameraWatcher(cam, inherit_cooldown=inherit_cooldown)
    t = Thread(target=watcher.run, name=f"watcher-{cam['id']}", daemon=True)
    t.start()
    return watcher, t

def thread_health_monitor(enabled_cameras: list[dict]):
    """
    [fix-4] On restart, copies cooldown state from the dead instance into the
    new one — no double-alerts after a watcher crashes mid-cooldown.
    """
    time.sleep(THREAD_CHECK_INTERVAL)
    while True:
        try:
            for cam in enabled_cameras:
                with _watcher_lock:
                    t = _watcher_threads.get(cam["id"])
                    if t is None or not t.is_alive():
                        old = _watcher_instances.get(cam["id"])
                        cooldown = old.cooldown_snapshot() if old else None
                        log.warning(f"[{cam['name']}] Thread dead — restarting (cooldown preserved)")
                        _ntfy_simple(
                            "iCMOB — Camera Restarted",
                            f"{cam['name']} watcher crashed and restarted automatically.",
                            tags="warning", priority="3"
                        )
                        watcher, thread = _spawn_watcher(cam, inherit_cooldown=cooldown)
                        _watcher_instances[cam["id"]] = watcher
                        _watcher_threads[cam["id"]]   = thread
        except Exception as e:
            log.error(f"Health monitor error: {e}")
        time.sleep(THREAD_CHECK_INTERVAL)

# ═══════════════════════════════════════════════════════════════════════
#  --test-cam CLI
# ═══════════════════════════════════════════════════════════════════════

def run_test(cam_id: str):
    """
    Usage: python icmob_monitor_v6.py --test-cam cam1
    Grabs one frame, detects IR mode, calls Gemini, prints result + saves snapshot.
    """
    cam = next((c for c in CAMERAS if c["id"] == cam_id), None)
    if cam is None:
        print(f"Unknown camera '{cam_id}'. Valid: {[c['id'] for c in CAMERAS]}")
        sys.exit(1)

    print(f"\n── Test: {cam['name']} ──────────────────────────────")
    print(f"RTSP  : {cam['rtsp_url'][:65]}...")
    print("Grabbing frame...")
    img = grab_frame(cam)
    if img is None:
        print("❌  Failed — check RTSP URL and DVR connectivity")
        sys.exit(1)

    print(f"✅  Frame: {img.size[0]}×{img.size[1]}px")
    ir = _is_ir_mode(img)
    print(f"    IR mode (night): {'yes' if ir else 'no'}")
    is_night = ir

    print("Pinging Gemini...")
    if not ping_gemini():
        print("❌  Gemini check failed")
        sys.exit(1)

    print("Analyzing...")
    result = analyze(cam, img, is_night)
    if result is None:
        print("❌  Gemini returned no result")
        sys.exit(1)

    print("\n── Result ──────────────────────────────────────────")
    for k, v in result.items():
        print(f"  {k:<12}: {v}")

    test_path = os.path.join(BASE_DIR, f"test_{cam_id}.jpg")
    img.save(test_path, format="JPEG", quality=85)
    print(f"\n📸  Snapshot → {test_path}")

    pause_path = _pause_file(cam_id)
    print(f"\n💡  Pause tip: touch {pause_path}")
    print(    f"              to silence {cam['name']} without restarting")
    print("────────────────────────────────────────────────────\n")

# ═══════════════════════════════════════════════════════════════════════
#  STARTUP CHECKS
# ═══════════════════════════════════════════════════════════════════════

def check_config() -> bool:
    ok = True
    if GEMINI_API_KEY == "your_gemini_api_key_here":
        log.error("❌ GEMINI_API_KEY not set — export GEMINI_API_KEY=... or paste key in config")
        ok = False
    if not [c for c in CAMERAS if c.get("enabled", True)]:
        log.error("❌ No cameras enabled")
        ok = False
    if NTFY_ENABLED and not NTFY_TOPIC:
        log.error("❌ NTFY_TOPIC is empty")
        ok = False
    return ok

# ═══════════════════════════════════════════════════════════════════════
#  MAIN
# ═══════════════════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(description="iCMOB AI Monitor v6")
    parser.add_argument("--test-cam", metavar="CAM_ID",
                        help="Test a camera: grab frame, run Gemini, print result. E.g. --test-cam cam1")
    args = parser.parse_args()

    if args.test_cam:
        run_test(args.test_cam)
        return

    log.info("=" * 56)
    log.info("  iCMOB AI Monitor v6 — Starting up")
    log.info("=" * 56)

    if not check_config():
        log.error("Fix errors above and run again.")
        return

    if not ping_gemini():
        log.error("Fix Gemini API key / model and run again.")
        return

    free_mb = check_disk_space(warn=True)
    log.info(f"Disk      : {free_mb:.0f} MB free")

    cleanup_old_snapshots()
    trim_event_log()

    enabled = [c for c in CAMERAS if c.get("enabled", True)]

    log.info(f"Cameras   : {[c['name'] for c in enabled]}")
    log.info(f"Thresholds: { {c['name']: c.get('motion_threshold', 8.0) for c in enabled} }")
    hours_str = f"{ACTIVE_HOURS[0]}:00-{ACTIVE_HOURS[1]}:59" if ACTIVE_HOURS else "24/7"
    log.info(f"Hours     : {hours_str}")
    log.info(f"Scan      : every {SCAN_INTERVAL_SEC}s (true interval)")
    log.info(f"Snapshots : {SNAPSHOT_KEEP_DAYS}d → {SNAP_BASE_DIR}")
    log.info(f"Event log : {EVENT_LOG_KEEP_DAYS}d → {EVENT_LOG_FILE}")
    with _gemini_model_lock:
        model_name = _active_gemini_model
    log.info(f"Model     : {model_name} (fallback: {GEMINI_MODEL_FALLBACK})")
    log.info(f"Ntfy      : {'✅ topic=' + NTFY_TOPIC if NTFY_ENABLED else '❌ OFF'}")
    log.info(f"Telegram  : {'✅' if TELEGRAM_ENABLED else '❌ OFF'}")
    log.info(f"Log files : {LOG_DIR}/monitor.log (5 MB rotate × 3)")
    log.info(f"Pause cam : touch ~/icmob_ai/pause_<cam_id>")
    log.info("=" * 56)

    Thread(target=background_tasks, daemon=True, name="background").start()

    for cam in enabled:
        with _watcher_lock:
            watcher, thread = _spawn_watcher(cam)
            _watcher_instances[cam["id"]] = watcher
            _watcher_threads[cam["id"]]   = thread
        time.sleep(2)

    Thread(target=thread_health_monitor, args=(enabled,),
           daemon=True, name="health-monitor").start()

    log.info(f"✅ All {len(enabled)} watchers running.")
    log.info("Test: python icmob_monitor_v6.py --test-cam cam1")
    log.info("Press Ctrl+C to stop.\n")

    # [fix-5] Startup notification — silence = something is wrong
    cam_names = ", ".join(c["name"] for c in enabled)
    _ntfy_simple(
        "iCMOB Started ✅",
        f"{len(enabled)} cameras live: {cam_names}\nModel: {model_name}",
        tags="white_check_mark", priority="2"
    )

    try:
        while True:
            time.sleep(60)
    except KeyboardInterrupt:
        log.info("Shutting down — draining notification queue...")
        _notify_executor.shutdown(wait=True, cancel_futures=False)
        log.info("Done.")

if __name__ == "__main__":
    main()
