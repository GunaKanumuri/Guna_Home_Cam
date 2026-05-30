"""
iCMOB AI Monitor v9 — Final Production Build
══════════════════════════════════════════════
Guna's home · 3 CP Plus cameras · DVR at 192.168.0.100
Stack: ffmpeg (RTSP) · Gemini Vision AI · Ntfy push · optional Telegram

DESIGNED FOR UNATTENDED OPERATION — runs for months without intervention.
Auto-recovers from: power outages, WiFi drops, DVR reboots, crashes.

NEW IN v9
═════════
[v9-1]  External config.json — never edit Python to change settings
[v9-2]  Offline notification queue — buffers alerts during WiFi outage
[v9-3]  Multi-frame burst — sends 3 frames to Gemini (motion visible in IR)
[v9-4]  Context injection — tells Gemini what was seen 30s ago same camera
[v9-5]  Family member descriptions — distinguishes family from strangers
[v9-6]  Cross-camera correlation — person at gate → first floor = same person
[v9-7]  Weekly summary — Sunday night trend analysis
[v9-8]  Mock mode — test without live cameras
[v9-9]  Gemini offline fallback — saves event even when API unreachable
[v9-10] WiFi resilience — retries indefinitely

FIXES APPLIED
═════════════
[fix-A] EVENT_PREFIX duplicate key removed — family now correctly mapped
[fix-B] _build_prompt cleaned — no duplicate lines, single clear instruction set
[fix-C] Detailed PERSON description — radio-style, gender+age+clothing+action+location

Dependencies: requests pillow numpy ffmpeg (system)
Run: bash start_icmob.sh
Test: python icmob_ai.py --test-cam cam1
"""

import io, os, sys, time, base64, logging, json, shutil, argparse, signal, glob
import requests, numpy as np, subprocess
from PIL          import Image
from datetime     import datetime, timedelta
from threading    import Thread, Lock, Semaphore, Event
from concurrent.futures import ThreadPoolExecutor
from logging.handlers   import RotatingFileHandler
from collections  import deque

HOME     = os.path.expanduser("~")
BASE_DIR = os.path.join(HOME, "icmob_ai")

# ═══════════════════════════════════════════════════════════════════════
#  CONFIG LOADER — [v9-1] external config.json
# ═══════════════════════════════════════════════════════════════════════

CONFIG_PATHS = [
    os.path.join(BASE_DIR, "config.json"),
    os.path.join(HOME, "config.json"),
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json"),
]

def _load_config() -> dict:
    defaults = {
        "cameras": [],
        "family_members": [],
        "gemini": {
            "api_key": os.getenv("GEMINI_API_KEY", ""),
            "model": "gemini-2.5-flash",
            "fallback_model": "gemini-2.0-flash",
            "temperature": 0.4,
            "max_output_tokens": 300,
        },
        "ntfy": {
            "enabled": True,
            "server": "https://ntfy.sh",
            "topic": os.getenv("NTFY_TOPIC", "guna-home-cams"),
            "token": os.getenv("NTFY_TOKEN", ""),
        },
        "telegram": {"enabled": False, "bot_token": "", "chat_id": ""},
        "monitoring": {
            "scan_interval_sec": 15,
            "loiter_check_delay_sec": 4,
            "min_alert_gap_sec": 60,
            "motion_reset_fail_count": 3,
            "active_hours": None,
            "snapshot_keep_days": 2,
            "event_log_keep_days": 90,
            "min_free_disk_mb": 300,
            "thread_check_interval_sec": 120,
            "heartbeat_interval_sec": 21600,
            "max_debug_files": 200,
            "multi_frame_count": 3,
            "multi_frame_interval_ms": 500,
            "backoff_steps_sec": [15, 30, 60, 120],
        },
        "image_quality": {
            "day_max_size": [640, 480],
            "day_jpeg_quality": 75,
            "night_max_size": [960, 720],
            "night_jpeg_quality": 90,
        },
    }

    for path in CONFIG_PATHS:
        if os.path.exists(path):
            try:
                with open(path) as f:
                    user_cfg = json.load(f)
                for key in defaults:
                    if key in user_cfg:
                        if isinstance(defaults[key], dict) and isinstance(user_cfg[key], dict):
                            defaults[key].update(user_cfg[key])
                        else:
                            defaults[key] = user_cfg[key]
                if os.getenv("GEMINI_API_KEY"):
                    defaults["gemini"]["api_key"] = os.getenv("GEMINI_API_KEY")
                if os.getenv("NTFY_TOPIC"):
                    defaults["ntfy"]["topic"] = os.getenv("NTFY_TOPIC")
                if os.getenv("NTFY_TOKEN"):
                    defaults["ntfy"]["token"] = os.getenv("NTFY_TOKEN")
                print(f"Config loaded: {path}")
                return defaults
            except json.JSONDecodeError as e:
                print(f"Invalid JSON in {path}: {e}")
                sys.exit(42)
            except Exception as e:
                print(f"Error reading {path}: {e}")

    print("No config.json found — using defaults + env vars")
    return defaults

CFG = _load_config()

CAMERAS           = CFG["cameras"]
FAMILY_MEMBERS    = CFG.get("family_members", [])
GEMINI_API_KEY    = CFG["gemini"]["api_key"]
GEMINI_MODEL      = CFG["gemini"]["model"]
GEMINI_FALLBACK   = CFG["gemini"]["fallback_model"]
GEMINI_TEMP       = CFG["gemini"]["temperature"]
GEMINI_MAX_TOKENS = CFG["gemini"]["max_output_tokens"]
NTFY_ENABLED      = CFG["ntfy"]["enabled"]
NTFY_SERVER       = CFG["ntfy"]["server"]
NTFY_TOPIC        = CFG["ntfy"]["topic"]
NTFY_TOKEN        = CFG["ntfy"]["token"]
TELE_ENABLED      = CFG["telegram"]["enabled"]
TELE_BOT_TOKEN    = CFG["telegram"]["bot_token"]
TELE_CHAT_ID      = CFG["telegram"]["chat_id"]
MON               = CFG["monitoring"]
SCAN_INTERVAL     = MON["scan_interval_sec"]
LOITER_DELAY      = MON["loiter_check_delay_sec"]
ALERT_GAP         = MON["min_alert_gap_sec"]
FAIL_RESET        = MON["motion_reset_fail_count"]
ACTIVE_HOURS      = MON["active_hours"]
SNAP_KEEP_DAYS    = MON["snapshot_keep_days"]
LOG_KEEP_DAYS     = MON["event_log_keep_days"]
MIN_DISK_MB       = MON["min_free_disk_mb"]
HEALTH_INTERVAL   = MON["thread_check_interval_sec"]
HEARTBEAT_SEC     = MON["heartbeat_interval_sec"]
MAX_DEBUG         = MON["max_debug_files"]
MULTI_FRAMES      = MON["multi_frame_count"]
MULTI_INTERVAL_MS = MON["multi_frame_interval_ms"]
BACKOFF_STEPS     = MON["backoff_steps_sec"]
IQ                = CFG["image_quality"]
DAY_SIZE          = tuple(IQ["day_max_size"])
DAY_QUAL          = IQ["day_jpeg_quality"]
NIGHT_SIZE        = tuple(IQ["night_max_size"])
NIGHT_QUAL        = IQ["night_jpeg_quality"]

LOG_DIR        = os.path.join(BASE_DIR, "logs")
EVENT_LOG      = os.path.join(LOG_DIR, "events.jsonl")
SNAP_DIR       = os.path.join(BASE_DIR, "snapshots")
DEBUG_DIR      = os.path.join(BASE_DIR, "debug")
HEARTBEAT_FILE = os.path.join(BASE_DIR, ".last_alive")
PENDING_FILE   = os.path.join(BASE_DIR, "pending_alerts.jsonl")

EVENT_CONFIG = {
    "person_detected":   {"alert": True,  "priority": "high",   "emoji": "bust_in_silhouette", "ntfy_pri": 4},
    "family_member":     {"alert": False, "priority": "low",    "emoji": "house",              "ntfy_pri": 2},
    "intruder_detected": {"alert": True,  "priority": "urgent", "emoji": "rotating_light",     "ntfy_pri": 5},
    "package_detected":  {"alert": True,  "priority": "medium", "emoji": "package",            "ntfy_pri": 3},
    "vehicle_detected":  {"alert": True,  "priority": "medium", "emoji": "car",                "ntfy_pri": 3},
    "animal_detected":   {"alert": True,  "priority": "low",    "emoji": "paw_prints",         "ntfy_pri": 2},
    "unknown_activity":  {"alert": True,  "priority": "medium", "emoji": "eyes",               "ntfy_pri": 3},
    "nothing_notable":   {"alert": False, "priority": "low",    "emoji": "white_check_mark",   "ntfy_pri": 1},
}

# [fix-A] Corrected — no duplicate keys, family correctly mapped
EVENT_PREFIX = {
    "person":   "person_detected",
    "family":   "family_member",
    "intruder": "intruder_detected",
    "package":  "package_detected",
    "vehicle":  "vehicle_detected",
    "animal":   "animal_detected",
    "unknown":  "unknown_activity",
    "nothing":  "nothing_notable",
}

# ═══════════════════════════════════════════════════════════════════════
#  LOGGING
# ═══════════════════════════════════════════════════════════════════════

for d in [LOG_DIR, BASE_DIR, SNAP_DIR, DEBUG_DIR]:
    os.makedirs(d, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        RotatingFileHandler(
            os.path.join(LOG_DIR, "monitor.log"),
            maxBytes=5 * 1024 * 1024, backupCount=3
        ),
        logging.StreamHandler()
    ]
)
log = logging.getLogger("icmob")
_pool     = ThreadPoolExecutor(max_workers=4, thread_name_prefix="ntfy")
_shutdown = Event()

# ═══════════════════════════════════════════════════════════════════════
#  FRAME GRABBER — in-memory pipe, -threads 1 for ARM
# ═══════════════════════════════════════════════════════════════════════

def grab_frame(camera: dict) -> Image.Image | None:
    tmp = os.path.join(BASE_DIR, f"snap_{camera['id']}.jpg")
    try:
        cmd = [
            "ffmpeg", "-y",
            "-threads", "1",
            "-rtsp_transport", "tcp",
            "-i", camera["rtsp_url"],
            "-vframes", "1",
            "-q:v", "3",
            tmp
        ]
        proc = subprocess.run(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=15
        )
        if proc.returncode == 0 and os.path.exists(tmp):
            with open(tmp, "rb") as f:
                img = Image.open(io.BytesIO(f.read())).convert("RGB")
            try:
                os.remove(tmp)
            except OSError:
                pass
            return img
        log.warning(f"[{camera['name']}] ffmpeg failed (code {proc.returncode})")
        return None
    except subprocess.TimeoutExpired:
        log.warning(f"[{camera['name']}] ffmpeg timeout")
        return None
    except Exception as e:
        log.error(f"[{camera['name']}] grab_frame: {e}")
        return None


def grab_burst(camera: dict, count: int = 3,
               interval_ms: int = 500) -> list[Image.Image]:
    """[v9-3] Grab multiple frames for multi-frame Gemini analysis."""
    frames = []
    for i in range(count):
        img = grab_frame(camera)
        if img:
            frames.append(img)
        if i < count - 1:
            time.sleep(interval_ms / 1000.0)
    return frames

# ═══════════════════════════════════════════════════════════════════════
#  IMAGE VALIDATION + IR DETECTION + ROI
# ═══════════════════════════════════════════════════════════════════════

def validate_frame(img: Image.Image) -> tuple[bool, str]:
    arr = np.array(img.convert("L"), dtype=np.float32)
    mu  = float(np.mean(arr))
    var = float(np.var(arr))
    if mu < 5:
        return False, f"too dark ({mu:.0f})"
    if var < 3:
        return False, f"no detail (var={var:.0f})"
    return True, "ok"


def is_ir_mode(img: Image.Image) -> bool:
    arr = np.array(img.resize((80, 60)), dtype=np.float32)
    r, g, b = arr[:,:,0], arr[:,:,1], arr[:,:,2]
    return float(np.max([
        np.mean(np.abs(r - g)),
        np.mean(np.abs(g - b)),
        np.mean(np.abs(r - b))
    ])) < 8.0


def apply_roi(img: Image.Image, camera: dict) -> Image.Image:
    roi = camera.get("roi_crop")
    if roi:
        try:
            return img.crop(roi)
        except Exception:
            pass
    return img

# ═══════════════════════════════════════════════════════════════════════
#  MOTION DETECTION
# ═══════════════════════════════════════════════════════════════════════

_prev:   dict[str, np.ndarray] = {}
_fails:  dict[str, int]        = {}
_ir_map: dict[str, bool]       = {}
_ir_lock = Lock()


def detect_motion(cam_id: str, img: Image.Image,
                  threshold: float, camera: dict) -> tuple[bool, float]:
    roi  = apply_roi(img, camera)
    gray = np.array(roi.convert("L").resize((160, 120)), dtype=np.float32)
    _fails[cam_id] = 0

    with _ir_lock:
        cur_ir = is_ir_mode(img)
        was_ir = _ir_map.get(cam_id, cur_ir)
        flip   = cur_ir != was_ir
        _ir_map[cam_id] = cur_ir

    if flip:
        _prev.pop(cam_id, None)
        log.info(f"[{cam_id}] IR transition — skipping frame")
        return False, 0.0

    eff = threshold * 1.4 if cur_ir else threshold
    if cam_id not in _prev:
        _prev[cam_id] = gray
        return False, 0.0

    score = float(np.mean(np.abs(gray - _prev[cam_id])))
    _prev[cam_id] = gray
    return score > eff, round(score, 2)


def increment_fail(cam_id: str):
    _fails[cam_id] = _fails.get(cam_id, 0) + 1
    if _fails[cam_id] >= FAIL_RESET:
        _prev.pop(cam_id, None)
        _fails[cam_id] = 0

# ═══════════════════════════════════════════════════════════════════════
#  CONTEXT TRACKER — [v9-4]
# ═══════════════════════════════════════════════════════════════════════

_last_events: dict[str, dict] = {}
_last_ev_lock = Lock()

# ═══════════════════════════════════════════════════════════════════════
#  EVENT CORRELATION — [v9-6]
# ═══════════════════════════════════════════════════════════════════════

_recent_detections: deque = deque(maxlen=50)
_corr_lock = Lock()


def _record_detection(camera: dict, result: dict):
    with _corr_lock:
        _recent_detections.append({
            "cam_id":   camera["id"],
            "cam_name": camera["name"],
            "event":    result.get("EVENT", ""),
            "person":   result.get("PERSON", "none"),
            "time":     time.time(),
        })


def _check_correlation(camera: dict, result: dict) -> str | None:
    if result.get("EVENT") not in ("person_detected", "intruder_detected"):
        return None
    now = time.time()
    with _corr_lock:
        for det in reversed(_recent_detections):
            if det["cam_id"] == camera["id"]:
                continue
            if now - det["time"] > 60:
                break
            if det["event"] in ("person_detected", "intruder_detected"):
                ago = int(now - det["time"])
                return f"Also seen at {det['cam_name']} {ago}s ago"
    return None

# ═══════════════════════════════════════════════════════════════════════
#  GEMINI AI
# ═══════════════════════════════════════════════════════════════════════

_model      = GEMINI_MODEL
_model_lock = Lock()
_gem_sem    = Semaphore(1)
_gem_time   = 0.0
_gem_tlock  = Lock()


def _rate_limit():
    global _gem_time
    with _gem_tlock:
        gap = time.time() - _gem_time
        if gap < 1.5:
            time.sleep(1.5 - gap)
        _gem_time = time.time()


# [fix-B] Corrected _build_prompt — single clean instruction set
# [fix-C] Detailed PERSON description rules
def _build_prompt(camera: dict, is_night: bool, ir: bool, cam_id: str) -> str:
    ctx = f"Camera: {camera['name']} — {camera['location']}"

    if ir:
        img_ctx = """IMAGE TYPE: Infrared (IR) night vision — black and white, grainy.
HOW TO READ IR IMAGES:
- People appear as bright white/grey shapes against dark background
- Eyes, skin, and light clothing reflect IR — appear brighter
- Look for human-shaped outlines, body posture, movement direction
- Do NOT dismiss any shape — describe what you see even if unclear"""
    elif is_night:
        img_ctx = "IMAGE TYPE: Low-light night capture. Describe shapes and outlines carefully."
    else:
        img_ctx = "IMAGE TYPE: Normal daylight — colors are accurate. Describe exactly what you see."

    # [v9-5] Family descriptions
    family_ctx = ""
    if FAMILY_MEMBERS:
        fam_list = "\n".join(f"  - {m}" for m in FAMILY_MEMBERS)
        family_ctx = f"""
KNOWN FAMILY MEMBERS who live here:
{fam_list}
If the person clearly matches one of these → EVENT: family_member
If NOT sure → EVENT: person_detected (safer)"""

    # [v9-4] Previous detection context
    prev_ctx = ""
    with _last_ev_lock:
        prev = _last_events.get(cam_id)
        if prev and time.time() - prev.get("time", 0) < 120:
            ago = int(time.time() - prev["time"])
            prev_ctx = f"\nCONTEXT ({ago}s ago this camera): {prev.get('event','')} — {prev.get('summary','')}"

    # Multi-frame note
    frame_note = "Multiple frames over ~1 second — look for MOVEMENT between them.\n" if MULTI_FRAMES > 1 else ""

    return f"""{ctx}
{img_ctx}
{family_ctx}
{prev_ctx}

{frame_note}TASK: You are a home security camera AI. Describe EXACTLY what you see.

Reply in EXACTLY this format — 6 lines only, no extra text:

EVENT: [person_detected | family_member | intruder_detected | package_detected | vehicle_detected | animal_detected | unknown_activity | nothing_notable]
ALERT: [yes | no]
SUMMARY: [short notification text, max 12 words, plain English]
PERSON: [detailed description — see rules below]
PRIORITY: [urgent | high | medium | low]
CONFIDENCE: [0-100]

━━━ EVENT RULES ━━━
- person_detected: ANY unknown person — walking, standing, passing by, at door, on stairs
- family_member: person clearly matching a known family member description above
- intruder_detected: ONLY suspicious behaviour — climbing walls, hiding, trying locks, breaking things. Walking or standing normally is NOT intruder even at 2am.
- package_detected: parcel, box, bag, delivery item left at door
- vehicle_detected: car, bike, auto, truck near gate or driveway
- animal_detected: dog, cat, cow, bird, rat etc
- unknown_activity: something changed but unclear what
- nothing_notable: empty scene, no people or activity

━━━ ALERT RULES ━━━
- ALERT=yes: person_detected, intruder_detected, package_detected, vehicle_detected, unknown_activity
- ALERT=no: nothing_notable, animal_detected, family_member
- PRIORITY=urgent ONLY for intruder with suspicious behaviour

━━━ PERSON DESCRIPTION RULES ━━━
Describe the person like reporting to a security guard over radio.
Include as many details as you can see:
  1. Gender: man / woman / boy / girl / person (if unclear)
  2. Age group: young / middle-aged / elderly
  3. Clothing — be specific:
     Daytime: "red shirt and dark pants" / "light green saree" / "blue kurta"
     Night IR: "light colored top and dark pants" / "all dark clothing" / "light saree"
  4. Action: walking / standing / sitting / running / knocking / bending / looking around
  5. Location: near gate / at front door / on staircase / on road / in balcony / inside compound
  6. Direction: entering / leaving / passing by / standing still / approaching camera

GOOD examples:
  "middle-aged man in white shirt and dark pants, walking towards main gate from road"
  "young woman in light blue saree, standing at front door, facing inside"
  "elderly person in light clothing, moving slowly up the staircase"
  "boy in school uniform, walking past gate on road, not entering"
  "person in dark jacket, standing near gate, facing the house (IR night)"

BAD (never write — too vague):
  "person detected" / "someone is there" / "a person is visible"

If no person: none
If too dark or blurry: "person visible but image unclear — check DVR"
"""


def _prepare_bytes(img: Image.Image, ir: bool) -> bytes:
    c   = img.copy()
    buf = io.BytesIO()
    if ir:
        c.thumbnail(NIGHT_SIZE)
        c.save(buf, format="JPEG", quality=NIGHT_QUAL)
    else:
        c.thumbnail(DAY_SIZE)
        c.save(buf, format="JPEG", quality=DAY_QUAL)
    return buf.getvalue()


def _prune_debug():
    try:
        files = sorted(
            [os.path.join(DEBUG_DIR, f) for f in os.listdir(DEBUG_DIR)],
            key=lambda p: os.path.getmtime(p)
        )
        while len(files) > MAX_DEBUG:
            os.remove(files.pop(0))
    except Exception:
        pass


def _save_debug(camera: dict, img_bytes: bytes, result: dict | None):
    try:
        ts   = datetime.now().strftime("%Y%m%d_%H%M%S")
        name = f"{camera['id']}_{ts}"
        with open(os.path.join(DEBUG_DIR, f"{name}.jpg"), "wb") as f:
            f.write(img_bytes)
        if result:
            with open(os.path.join(DEBUG_DIR, f"{name}.json"), "w") as f:
                json.dump(result, f, indent=2)
        _prune_debug()
    except Exception:
        pass


def _normalize_event(raw: str) -> str:
    raw = raw.lower().strip()
    if raw in EVENT_CONFIG:
        return raw
    for pfx, full in EVENT_PREFIX.items():
        if raw.startswith(pfx):
            return full
    return raw


def _parse_response(text: str) -> dict | None:
    result = {}
    for line in text.strip().splitlines():
        if ":" in line:
            k, _, v = line.partition(":")
            key = k.strip().upper()
            if key in ("EVENT", "ALERT", "SUMMARY", "PERSON", "PRIORITY", "CONFIDENCE"):
                result[key] = v.strip()
    if "EVENT" not in result:
        return None
    result["EVENT"] = _normalize_event(result["EVENT"])
    try:
        c = int(result.get("CONFIDENCE", "0"))
        result["CONFIDENCE"] = c if c > 0 else 80
    except (ValueError, TypeError):
        result["CONFIDENCE"] = 80
    result.setdefault("PERSON",   "none")
    result.setdefault("ALERT",    "no")
    result.setdefault("PRIORITY", "medium")
    result.setdefault("SUMMARY",  "Activity detected")
    return result


def _call_api(model: str, camera: dict,
              frames_bytes: list[bytes], prompt: str) -> dict | None:
    _rate_limit()
    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/"
        f"{model}:generateContent?key={GEMINI_API_KEY}"
    )
    parts = [{"text": prompt}]
    for fb in frames_bytes:
        parts.append({"inline_data": {
            "mime_type": "image/jpeg",
            "data": base64.b64encode(fb).decode()
        }})
    payload = {
        "contents": [{"parts": parts}],
        "generationConfig": {
            "maxOutputTokens": GEMINI_MAX_TOKENS,
            "temperature":     GEMINI_TEMP,
        }
    }
    r = requests.post(
        url, json=payload,
        headers={"Content-Type": "application/json"},
        timeout=25
    )
    if r.status_code == 429:
        raise requests.exceptions.ConnectionError("rate_limited")
    if r.status_code == 404:
        raise requests.exceptions.ConnectionError("model_not_found")
    if r.status_code != 200:
        log.error(f"Gemini {r.status_code}: {r.text[:200]}")
        return None
    text   = r.json()["candidates"][0]["content"]["parts"][0]["text"]
    total_kb = sum(len(b) for b in frames_bytes) // 1024
    log.info(f"[{camera['name']}] GEMINI ({len(frames_bytes)}fr/{total_kb}KB): {text.strip()[:300]}")
    return _parse_response(text)


def analyze(camera: dict, frames: list[Image.Image],
            is_night: bool, ir: bool) -> dict | None:
    global _model
    if not frames:
        return None
    frames_bytes = [_prepare_bytes(f, ir) for f in frames]
    prompt       = _build_prompt(camera, is_night, ir, camera["id"])

    with _gem_sem:
        for attempt in range(2):
            try:
                with _model_lock:
                    model = _model
                result = _call_api(model, camera, frames_bytes, prompt)
                _save_debug(camera, frames_bytes[0], result)
                if result:
                    with _last_ev_lock:
                        _last_events[camera["id"]] = {
                            "event":   result.get("EVENT", ""),
                            "person":  result.get("PERSON", ""),
                            "summary": result.get("SUMMARY", ""),
                            "time":    time.time(),
                        }
                return result

            except requests.exceptions.Timeout:
                if attempt == 0:
                    log.warning(f"[{camera['name']}] Gemini timeout — retry 3s")
                    time.sleep(3)
                else:
                    return None

            except requests.exceptions.ConnectionError as e:
                err = str(e)
                if "model_not_found" in err:
                    with _model_lock:
                        if _model != GEMINI_FALLBACK:
                            log.warning(f"Model gone — fallback {GEMINI_FALLBACK}")
                            _model = GEMINI_FALLBACK
                    try:
                        result = _call_api(GEMINI_FALLBACK, camera, frames_bytes, prompt)
                        _save_debug(camera, frames_bytes[0], result)
                        return result
                    except Exception:
                        return None
                elif "rate_limited" in err and attempt == 0:
                    log.warning(f"[{camera['name']}] 429 — retry 10s")
                    time.sleep(10)
                else:
                    return None

            except Exception as e:
                log.error(f"[{camera['name']}] Gemini: {e}")
                return None
    return None


def ping_gemini() -> bool:
    global _model
    for m in [GEMINI_MODEL, GEMINI_FALLBACK]:
        try:
            url = (
                f"https://generativelanguage.googleapis.com/v1beta/models/"
                f"{m}:generateContent?key={GEMINI_API_KEY}"
            )
            r = requests.post(url,
                json={"contents": [{"parts": [{"text": "Say OK"}]}],
                      "generationConfig": {"maxOutputTokens": 5}},
                headers={"Content-Type": "application/json"}, timeout=10)
            if r.status_code == 200:
                with _model_lock:
                    _model = m
                log.info(f"✅ Gemini OK — {m}")
                return True
            elif r.status_code == 404 and m == GEMINI_MODEL:
                continue
            else:
                log.error(f"❌ Gemini {m}: {r.status_code}")
                if m == GEMINI_MODEL:
                    continue
                return False
        except Exception as e:
            log.error(f"❌ Gemini {m}: {e}")
            if m == GEMINI_MODEL:
                continue
            return False
    return False

# ═══════════════════════════════════════════════════════════════════════
#  DISK
# ═══════════════════════════════════════════════════════════════════════

def check_disk(warn=True) -> float:
    try:
        free = shutil.disk_usage(BASE_DIR).free / (1024 * 1024)
        if warn and free < MIN_DISK_MB:
            _ntfy_simple("iCMOB — Low Disk", f"⚠️ {free:.0f} MB free",
                         tags="warning", priority="4")
        return free
    except Exception:
        return 9999.0

# ═══════════════════════════════════════════════════════════════════════
#  OFFLINE NOTIFICATION QUEUE — [v9-2]
# ═══════════════════════════════════════════════════════════════════════

_pending_lock = Lock()


def _queue_notification(data: dict):
    try:
        with _pending_lock:
            with open(PENDING_FILE, "a") as f:
                f.write(json.dumps(data) + "\n")
        log.info("📥 Notification queued (offline)")
    except Exception as e:
        log.error(f"Queue: {e}")


def _replay_pending():
    if not os.path.exists(PENDING_FILE):
        return
    try:
        with _pending_lock:
            with open(PENDING_FILE) as f:
                lines = f.readlines()
            if not lines:
                return
        sent = 0
        failed = []
        for line in lines:
            try:
                data = json.loads(line)
                headers = {
                    "Title":    data.get("title", "iCMOB"),
                    "Tags":     data.get("tags", "bell"),
                    "Priority": str(data.get("priority", "3")),
                    "Message":  data.get("message", ""),
                }
                if NTFY_TOKEN:
                    headers["Authorization"] = f"Bearer {NTFY_TOKEN}"
                r = requests.post(
                    f"{NTFY_SERVER}/{NTFY_TOPIC}",
                    headers=headers, timeout=10
                )
                if r.status_code in (200, 201):
                    sent += 1
                else:
                    failed.append(line)
            except requests.exceptions.ConnectionError:
                failed.append(line)
                break
            except Exception:
                failed.append(line)
        with _pending_lock:
            with open(PENDING_FILE, "w") as f:
                f.writelines(failed)
        if sent:
            log.info(f"📤 Replayed {sent} queued notifications")
    except Exception as e:
        log.error(f"Replay: {e}")

# ═══════════════════════════════════════════════════════════════════════
#  NOTIFICATIONS
# ═══════════════════════════════════════════════════════════════════════

def _ntfy_auth() -> dict:
    return {"Authorization": f"Bearer {NTFY_TOKEN}"} if NTFY_TOKEN else {}


def _build_body(camera: dict, result: dict, score: float) -> str:
    summary = result.get("SUMMARY", "Activity detected")
    person  = result.get("PERSON", "none").strip()
    conf    = result.get("CONFIDENCE", 80)
    prio    = result.get("PRIORITY", "medium").lower()
    thresh  = camera.get("motion_threshold", 8.0)

    if person and person.lower() not in ("none", "n/a", "", "none visible"):
        body = f"{person.capitalize()} — {summary}"
    else:
        body = summary

    corr = _check_correlation(camera, result)
    if corr:
        body += f"\n↗ {corr}"

    if conf >= 85:
        body += f" ({conf}%)"
    elif conf >= 60:
        body += f" (~{conf}%)"

    if score >= thresh * 2:
        body += " ⚡"

    if prio == "urgent":
        body = "🚨 " + body

    return body


def _send_ntfy(camera: dict, result: dict,
               img: Image.Image | None, score: float):
    if not NTFY_ENABLED:
        return
    event = result.get("EVENT", "unknown_activity")
    cfg   = EVENT_CONFIG.get(event, EVENT_CONFIG["unknown_activity"])
    body  = _build_body(camera, result, score)
    headers = {
        **_ntfy_auth(),
        "Title":    camera["name"],
        "Tags":     cfg["emoji"],
        "Priority": str(cfg["ntfy_pri"]),
        "Message":  body,
    }
    for attempt in range(2):
        try:
            if img:
                buf = io.BytesIO()
                img.save(buf, format="JPEG", quality=80)
                buf.seek(0)
                r = requests.put(
                    f"{NTFY_SERVER}/{NTFY_TOPIC}", data=buf,
                    headers={**headers, "Filename": "snapshot.jpg"}, timeout=10
                )
            else:
                r = requests.post(
                    f"{NTFY_SERVER}/{NTFY_TOPIC}",
                    headers=headers, timeout=10
                )
            if r.status_code in (200, 201):
                log.info(f"✅ Ntfy → [{camera['name']}] {body[:80]}")
                return
        except requests.exceptions.ConnectionError:
            pass
        except Exception as e:
            log.warning(f"Ntfy err (att {attempt+1}): {e}")
        if attempt == 0:
            time.sleep(3)
    log.warning("❌ Ntfy failed — queuing")
    _queue_notification({
        "title":    camera["name"],
        "tags":     cfg["emoji"],
        "priority": cfg["ntfy_pri"],
        "message":  f"[DELAYED] {body}",
    })


def _send_telegram(camera: dict, result: dict,
                   img: Image.Image | None, score: float):
    if not TELE_ENABLED:
        return
    body = _build_body(camera, result, score)
    text = f"📍 *{camera['name']}*\n{body}"
    try:
        base = f"https://api.telegram.org/bot{TELE_BOT_TOKEN}"
        if img:
            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=80)
            buf.seek(0)
            requests.post(f"{base}/sendPhoto",
                data={"chat_id": TELE_CHAT_ID, "caption": text, "parse_mode": "Markdown"},
                files={"photo": ("snap.jpg", buf, "image/jpeg")}, timeout=15)
        else:
            requests.post(f"{base}/sendMessage",
                json={"chat_id": TELE_CHAT_ID, "text": text, "parse_mode": "Markdown"},
                timeout=10)
    except Exception as e:
        log.error(f"Telegram: {e}")


def send_notifications(camera: dict, result: dict,
                       img: Image.Image | None, score: float):
    event = result.get("EVENT", "")
    cfg   = EVENT_CONFIG.get(event, {})
    if not cfg.get("alert", False):
        return
    if result.get("ALERT", "no").lower() != "yes":
        return
    _pool.submit(_send_ntfy,     camera, result, img, score)
    _pool.submit(_send_telegram, camera, result, img, score)


def _ntfy_simple(title: str, msg: str, tags="bell", priority="2"):
    if not NTFY_ENABLED:
        return
    try:
        requests.post(f"{NTFY_SERVER}/{NTFY_TOPIC}", headers={
            **_ntfy_auth(),
            "Title": title, "Tags": tags,
            "Priority": priority, "Message": msg,
        }, timeout=8)
    except requests.exceptions.ConnectionError:
        _queue_notification({"title": title, "tags": tags,
                             "priority": int(priority), "message": msg})
    except Exception:
        pass

# ═══════════════════════════════════════════════════════════════════════
#  STORAGE
# ═══════════════════════════════════════════════════════════════════════

_elog_lock = Lock()


def save_event(camera: dict, result: dict, score: float,
               is_night: bool, ir: bool) -> str:
    now = datetime.now()
    eid = f"{camera['id']}_{int(now.timestamp())}"
    rec = {
        "event_id":     eid,
        "timestamp":    now.isoformat(),
        "camera_id":    camera["id"],
        "camera_name":  camera["name"],
        "event":        result.get("EVENT", ""),
        "alert":        result.get("ALERT", "no"),
        "summary":      result.get("SUMMARY", ""),
        "person":       result.get("PERSON", "none"),
        "priority":     result.get("PRIORITY", "low"),
        "confidence":   result.get("CONFIDENCE", 0),
        "motion_score": score,
        "night":        is_night,
        "ir_mode":      ir,
    }
    try:
        with _elog_lock:
            with open(EVENT_LOG, "a") as f:
                f.write(json.dumps(rec) + "\n")
    except Exception as e:
        log.error(f"save_event: {e}")
    return eid


def save_snapshot(camera: dict, img: Image.Image, eid: str):
    if check_disk(warn=False) < MIN_DISK_MB:
        return
    try:
        d = os.path.join(SNAP_DIR, camera["id"])
        os.makedirs(d, exist_ok=True)
        img.save(os.path.join(d, f"{eid}.jpg"), format="JPEG", quality=85)
    except Exception as e:
        log.error(f"snapshot: {e}")


def cleanup_old():
    cutoff = time.time() - (SNAP_KEEP_DAYS * 86400)
    n = 0
    for root, _, files in os.walk(SNAP_DIR):
        for f in files:
            fp = os.path.join(root, f)
            try:
                if os.path.getmtime(fp) < cutoff:
                    os.remove(fp)
                    n += 1
            except Exception:
                pass
    dc = time.time() - 86400
    for f in os.listdir(DEBUG_DIR):
        try:
            fp = os.path.join(DEBUG_DIR, f)
            if os.path.getmtime(fp) < dc:
                os.remove(fp)
        except Exception:
            pass
    if n:
        log.info(f"Cleaned {n} old snapshots")


def trim_log():
    if not os.path.exists(EVENT_LOG):
        return
    cutoff = (datetime.now() - timedelta(days=LOG_KEEP_DAYS)).isoformat()
    kept = dropped = 0
    tmp  = EVENT_LOG + ".tmp"
    try:
        with open(EVENT_LOG) as src, open(tmp, "w") as dst:
            for line in src:
                try:
                    e = json.loads(line)
                    if e.get("timestamp", "") >= cutoff:
                        dst.write(line)
                        kept += 1
                    else:
                        dropped += 1
                except Exception:
                    dst.write(line)
        if dropped:
            os.replace(tmp, EVENT_LOG)
            log.info(f"Log trimmed: -{dropped} +{kept}")
        else:
            os.remove(tmp)
    except Exception as e:
        log.error(f"trim: {e}")
        try:
            os.remove(tmp)
        except Exception:
            pass

# ═══════════════════════════════════════════════════════════════════════
#  DAILY + WEEKLY SUMMARIES — [v9-7]
# ═══════════════════════════════════════════════════════════════════════

def _count_events(date_prefix: str) -> dict:
    counts = {"total": 0, "person": 0, "family": 0, "intruder": 0,
              "package": 0, "vehicle": 0, "animal": 0, "unknown": 0}
    if not os.path.exists(EVENT_LOG):
        return counts
    try:
        with open(EVENT_LOG) as f:
            for line in f:
                try:
                    e = json.loads(line)
                    if not e.get("timestamp", "").startswith(date_prefix):
                        continue
                    counts["total"] += 1
                    evt = e.get("event", "")
                    if evt == "person_detected":    counts["person"]   += 1
                    elif evt == "family_member":    counts["family"]   += 1
                    elif evt == "intruder_detected":counts["intruder"] += 1
                    elif evt == "package_detected": counts["package"]  += 1
                    elif evt == "vehicle_detected": counts["vehicle"]  += 1
                    elif evt == "animal_detected":  counts["animal"]   += 1
                    elif evt == "unknown_activity": counts["unknown"]  += 1
                except Exception:
                    continue
    except Exception:
        pass
    return counts


def send_daily_summary():
    if not NTFY_ENABLED:
        return
    today = datetime.now().date().isoformat()
    c = _count_events(today)
    if c["total"] == 0:
        _ntfy_simple(f"📊 Daily — {today}",
                     "Quiet day — no events. System OK ✅",
                     tags="white_check_mark")
        return
    parts = [f"{c['total']} events"]
    if c["person"]:    parts.append(f"{c['person']} visitors")
    if c["family"]:    parts.append(f"{c['family']} family")
    if c["intruder"]:  parts.append(f"{c['intruder']} intruders ⚠️")
    if c["package"]:   parts.append(f"{c['package']} packages")
    if c["vehicle"]:   parts.append(f"{c['vehicle']} vehicles")
    body = ", ".join(parts)
    _ntfy_simple(f"📊 Daily — {today}", body, tags="bar_chart")
    log.info(f"Daily: {body}")


def send_weekly_summary():
    """[v9-7] Sunday night weekly trend."""
    if not NTFY_ENABLED:
        return
    if datetime.now().weekday() != 6:
        return
    totals = {"total": 0, "person": 0, "family": 0, "intruder": 0,
              "package": 0, "vehicle": 0}
    busiest_day   = ""
    busiest_count = 0
    for i in range(7):
        day = (datetime.now() - timedelta(days=i)).date().isoformat()
        c = _count_events(day)
        for k in totals:
            totals[k] += c.get(k, 0)
        if c["total"] > busiest_count:
            busiest_count = c["total"]
            busiest_day   = day
    if totals["total"] == 0:
        _ntfy_simple("📈 Weekly", "Very quiet week — 0 events",
                     tags="chart_with_upwards_trend")
        return
    parts = [f"{totals['total']} events this week"]
    if totals["person"]:   parts.append(f"{totals['person']} visitors")
    if totals["family"]:   parts.append(f"{totals['family']} family")
    if totals["intruder"]: parts.append(f"{totals['intruder']} intruders ⚠️")
    if totals["package"]:  parts.append(f"{totals['package']} packages")
    body = ", ".join(parts)
    if busiest_day:
        body += f"\nBusiest: {busiest_day} ({busiest_count} events)"
    _ntfy_simple("📈 Weekly Summary", body, tags="chart_with_upwards_trend")
    log.info(f"Weekly: {body[:100]}")

# ═══════════════════════════════════════════════════════════════════════
#  HEARTBEAT + POWER OUTAGE + BATTERY
# ═══════════════════════════════════════════════════════════════════════

def _write_hb():
    try:
        with open(HEARTBEAT_FILE, "w") as f:
            f.write(datetime.now().isoformat())
    except Exception:
        pass


def _check_outage():
    if not os.path.exists(HEARTBEAT_FILE):
        _write_hb()
        return
    try:
        with open(HEARTBEAT_FILE) as f:
            last = datetime.fromisoformat(f.read().strip())
        mins = int((datetime.now() - last).total_seconds() / 60)
        if mins > 10:
            if mins < 60:
                dur = f"{mins} minutes"
            elif mins < 1440:
                dur = f"{mins//60}h {mins%60}m"
            else:
                dur = f"{mins//1440}d {(mins%1440)//60}h"
            _ntfy_simple(
                "⚡ iCMOB — Was Offline",
                f"Offline for {dur}\n"
                f"Last seen: {last.strftime('%b %d %I:%M %p')}\n"
                f"Back now: {datetime.now().strftime('%b %d %I:%M %p')}",
                tags="electric_plug", priority="4"
            )
            log.warning(f"Outage: {dur}")
        else:
            log.info(f"Last heartbeat {mins}m ago — normal")
    except Exception as e:
        log.warning(f"Heartbeat read: {e}")
    _write_hb()


def check_battery():
    try:
        r = subprocess.run(
            ["termux-battery-status"],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5
        )
        if r.returncode != 0:
            return
        s    = json.loads(r.stdout.decode())
        pct  = s.get("percentage", 100)
        plug = s.get("plugged", "")
        if plug == "UNPLUGGED":
            _ntfy_simple("🔌 Phone Unplugged!",
                         f"Battery {pct}% — plug in now!",
                         tags="electric_plug", priority="4")
        elif pct < 15:
            _ntfy_simple("🪫 Low Battery",
                         f"{pct}% — check charger",
                         tags="battery", priority="3")
    except FileNotFoundError:
        pass
    except Exception:
        pass

# ═══════════════════════════════════════════════════════════════════════
#  BACKGROUND TASKS
# ═══════════════════════════════════════════════════════════════════════

def _secs_to_midnight() -> float:
    now = datetime.now()
    mid = (now + timedelta(days=1)).replace(
        hour=0, minute=0, second=0, microsecond=0)
    return (mid - now).total_seconds()


def bg_daily():
    _shutdown.wait(timeout=_secs_to_midnight())
    while not _shutdown.is_set():
        try:
            cleanup_old()
            trim_log()
            check_disk(warn=True)
            check_battery()
            send_daily_summary()
            send_weekly_summary()
            _replay_pending()
        except Exception as e:
            log.error(f"Daily task: {e}")
        _shutdown.wait(timeout=86400)


def bg_heartbeat():
    while not _shutdown.is_set():
        _shutdown.wait(timeout=HEARTBEAT_SEC)
        if _shutdown.is_set():
            break
        try:
            _write_hb()
            _replay_pending()
            with _watcher_lock:
                alive = sum(1 for t in _threads.values() if t.is_alive())
                total = len(_threads)
            free = check_disk(warn=False)
            _ntfy_simple("💚 Heartbeat",
                         f"{alive}/{total} cams OK · {free:.0f}MB free",
                         tags="green_heart", priority="1")
        except Exception as e:
            log.error(f"Heartbeat: {e}")

# ═══════════════════════════════════════════════════════════════════════
#  GRACEFUL SHUTDOWN
# ═══════════════════════════════════════════════════════════════════════

def _sig_handler(signum, frame):
    log.info(f"Signal {signum} — shutting down...")
    _shutdown.set()

# ═══════════════════════════════════════════════════════════════════════
#  PAUSE + ACTIVE HOURS
# ═══════════════════════════════════════════════════════════════════════

def is_paused(cam_id: str) -> bool:
    return os.path.exists(os.path.join(BASE_DIR, f"pause_{cam_id}"))


def _active() -> bool:
    if ACTIVE_HOURS is None:
        return True
    h = datetime.now().hour
    return ACTIVE_HOURS[0] <= h <= ACTIVE_HOURS[1]

# ═══════════════════════════════════════════════════════════════════════
#  CAMERA WATCHER
# ═══════════════════════════════════════════════════════════════════════

class CameraWatcher:
    def __init__(self, camera: dict, cooldown: dict | None = None):
        self.cam    = camera
        self.name   = camera["name"]
        self.cid    = camera["id"]
        self.thresh = camera.get("motion_threshold", 8.0)
        self.frames = 0
        self.alerts = 0
        self.cfails = 0
        self._cd: dict[str, float] = cooldown or {}
        self._last_key = ""

    def cd_snap(self) -> dict:
        return dict(self._cd)

    def _can(self, evt: str) -> bool:
        return time.time() - self._cd.get(evt, 0) >= ALERT_GAP

    def _mark(self, evt: str):
        self._cd[evt] = time.time()

    def _backoff(self):
        idx = min(self.cfails - 1, len(BACKOFF_STEPS) - 1)
        w   = BACKOFF_STEPS[idx]
        if self.cfails == 1 or self.cfails % 5 == 0:
            log.warning(f"[{self.name}] {self.cfails} RTSP fails — wait {w}s")
        time.sleep(w)

    def _is_dup(self, result: dict) -> bool:
        key = f"{result.get('EVENT','')}|{result.get('PERSON','').lower()}"
        if key == self._last_key:
            return True
        self._last_key = key
        return False

    def _process(self, img: Image.Image, score: float,
                 is_night: bool, ir: bool):
        self.frames += 1

        # Fast motion = immediate burst, no loiter wait
        if score >= self.thresh * 3:
            log.info(f"[{self.name}] ⚡ Fast motion {score} — immediate burst")
            frames = grab_burst(self.cam, MULTI_FRAMES, MULTI_INTERVAL_MS)
        else:
            log.info(f"[{self.name}] Motion {score} — loiter {LOITER_DELAY}s...")
            time.sleep(LOITER_DELAY)
            img2 = grab_frame(self.cam)
            if img2 is None:
                return
            m2, s2 = detect_motion(self.cid, img2, self.thresh, self.cam)
            if not m2:
                log.info(f"[{self.name}] Loiter: motion gone — skipping")
                return
            frames = [img2] + [f for f in
                [grab_frame(self.cam) for _ in range(MULTI_FRAMES - 1)] if f]
            score  = s2

        if not frames:
            return

        valid, reason = validate_frame(frames[0])
        if not valid:
            log.info(f"[{self.name}] Frame rejected: {reason}")
            return

        # [v9-9] Gemini offline fallback
        result = analyze(self.cam, frames, is_night, ir)
        if not result:
            result = {
                "EVENT":      "unknown_activity",
                "ALERT":      "yes",
                "SUMMARY":    f"Motion detected (AI offline, score {score})",
                "PERSON":     "none",
                "PRIORITY":   "medium",
                "CONFIDENCE": 50,
            }
            log.warning(f"[{self.name}] Gemini offline — saving motion event")

        event = result.get("EVENT", "")
        conf  = result.get("CONFIDENCE", 80)
        log.info(f"[{self.name}] {event} | conf={conf}% | {result.get('SUMMARY','')}")

        _record_detection(self.cam, result)
        eid = save_event(self.cam, result, score, is_night, ir)
        save_snapshot(self.cam, frames[0], eid)

        if result.get("ALERT", "no").lower() != "yes":
            return

        # Confidence floor
        mc = 55
        if event == "intruder_detected":
            mc = 70
        elif event == "unknown_activity":
            mc = 60
        if conf < mc:
            log.info(f"[{self.name}] Conf {conf}% < {mc}% — skip")
            return

        if self._is_dup(result):
            log.info(f"[{self.name}] Duplicate — skip")
            return

        if is_paused(self.cid):
            log.info(f"[{self.name}] Paused — skip notify")
            return

        if self._can(event):
            send_notifications(self.cam, result, frames[0], score)
            self._mark(event)
            self.alerts += 1
        else:
            rem = int(ALERT_GAP - (time.time() - self._cd.get(event, 0)))
            log.info(f"[{self.name}] Cooldown {event} — {rem}s")

    def run(self):
        log.info(f"[{self.name}] Watcher started (thresh={self.thresh})")
        while not _shutdown.is_set():
            try:
                if not _active():
                    if _shutdown.wait(30):
                        break
                    continue

                t0       = time.time()
                now      = datetime.now()
                is_night = now.hour >= 22 or now.hour < 6
                img      = grab_frame(self.cam)

                if img is None:
                    self.cfails += 1
                    increment_fail(self.cid)
                    self._backoff()
                    continue

                self.cfails = 0
                ir = is_ir_mode(img)
                motion, score = detect_motion(
                    self.cid, img, self.thresh, self.cam)

                log.info(f"[{self.name}] frame OK {img.size} ir={ir} motion={motion} score={score} thresh={self.thresh}")

                if motion:
                    self._process(img, score, is_night, ir)

                elapsed = time.time() - t0
                if _shutdown.wait(timeout=max(0, SCAN_INTERVAL - elapsed)):
                    break

            except KeyboardInterrupt:
                break
            except Exception as e:
                log.error(f"[{self.name}] Error: {e} — retry 10s")
                time.sleep(10)

        log.info(f"[{self.name}] Stopped. frames={self.frames} alerts={self.alerts}")

# ═══════════════════════════════════════════════════════════════════════
#  THREAD HEALTH MONITOR
# ═══════════════════════════════════════════════════════════════════════

_watchers:    dict[str, CameraWatcher] = {}
_threads:     dict[str, Thread]        = {}
_watcher_lock = Lock()


def _spawn(cam: dict, cd: dict | None = None) -> tuple[CameraWatcher, Thread]:
    w = CameraWatcher(cam, cooldown=cd)
    t = Thread(target=w.run, name=f"wat-{cam['id']}", daemon=True)
    t.start()
    return w, t


def health_monitor(cams: list[dict]):
    _shutdown.wait(timeout=HEALTH_INTERVAL)
    while not _shutdown.is_set():
        try:
            for cam in cams:
                with _watcher_lock:
                    t = _threads.get(cam["id"])
                    if t and t.is_alive():
                        continue
                    old = _watchers.get(cam["id"])
                    cd  = old.cd_snap() if old else None
                    log.warning(f"[{cam['name']}] Dead — restarting")
                    _ntfy_simple("⚠️ Camera Restarted",
                                 f"{cam['name']} auto-restarted",
                                 tags="warning", priority="3")
                    w, th = _spawn(cam, cd=cd)
                    _watchers[cam["id"]] = w
                    _threads[cam["id"]]  = th
        except Exception as e:
            log.error(f"Health: {e}")
        _shutdown.wait(timeout=HEALTH_INTERVAL)

# ═══════════════════════════════════════════════════════════════════════
#  TEST + MOCK — [v9-8]
# ═══════════════════════════════════════════════════════════════════════

def run_test(cam_id: str):
    cam = next((c for c in CAMERAS if c["id"] == cam_id), None)
    if not cam:
        print(f"Unknown camera. Valid: {[c['id'] for c in CAMERAS]}")
        sys.exit(1)

    print(f"\n{'═'*52}")
    print(f"  TEST: {cam['name']} ({cam_id})")
    print(f"{'═'*52}")

    print("\n1. Grabbing frames...")
    frames = grab_burst(cam, MULTI_FRAMES, MULTI_INTERVAL_MS)
    if not frames:
        print("   ❌ No frames — check RTSP and DVR")
        sys.exit(1)
    print(f"   ✅ {len(frames)} frames, {frames[0].size[0]}×{frames[0].size[1]}px")
    ir       = is_ir_mode(frames[0])
    is_night = ir
    print(f"   IR mode: {'yes — night vision' if ir else 'no — colour'}")
    print(f"   Quality: {'NIGHT 90% JPEG 960×720' if ir else 'DAY 75% JPEG 640×480'}")

    print("\n2. Validating frame...")
    ok, reason = validate_frame(frames[0])
    if not ok:
        print(f"   ❌ Rejected: {reason}")
        sys.exit(1)
    print("   ✅ Valid")

    print("\n3. Pinging Gemini...")
    if not ping_gemini():
        print("   ❌ Failed — check API key")
        sys.exit(1)

    print(f"\n4. Analyzing {len(frames)} frame(s)...")
    result = analyze(cam, frames, is_night, ir)
    if not result:
        print("   ❌ No result from Gemini")
        sys.exit(1)

    print(f"\n{'─'*52}")
    for k in ["EVENT", "ALERT", "SUMMARY", "PERSON", "PRIORITY", "CONFIDENCE"]:
        print(f"  {k:<12}: {result.get(k, '—')}")

    body = _build_body(cam, result, 0)
    print(f"\n  📱 Notification preview:")
    print(f"     Title: {cam['name']}")
    print(f"     Body:  {body}")

    bts = _prepare_bytes(frames[0], ir)
    dp  = os.path.join(DEBUG_DIR, f"test_{cam_id}.jpg")
    with open(dp, "wb") as f:
        f.write(bts)
    print(f"\n  📸 Image sent to Gemini → {dp} ({len(bts)//1024}KB)")
    print(f"     (exact image Gemini analyzed)")
    print(f"{'═'*52}\n")


def run_mock():
    """[v9-8] Replay saved debug images through Gemini."""
    images = glob.glob(os.path.join(DEBUG_DIR, "*.jpg"))
    if not images:
        print("No debug images. Run --test-cam first.")
        sys.exit(1)
    images = sorted(images)[-5:]
    print(f"\n{'═'*52}")
    print(f"  MOCK MODE — {len(images)} saved images")
    print(f"{'═'*52}")
    if not ping_gemini():
        print("❌ Gemini failed")
        sys.exit(1)
    cam = CAMERAS[0] if CAMERAS else {
        "id": "mock", "name": "Mock", "location": "test", "motion_threshold": 8.0}
    for i, path in enumerate(images):
        print(f"\n── Image {i+1}: {os.path.basename(path)}")
        img    = Image.open(path).convert("RGB")
        ir     = is_ir_mode(img)
        result = analyze(cam, [img], ir, ir)
        if result:
            for k in ["EVENT", "SUMMARY", "PERSON", "CONFIDENCE"]:
                print(f"  {k:<12}: {result.get(k, '—')}")
        else:
            print("  ❌ No result")
    print(f"\n{'═'*52}\n")

# ═══════════════════════════════════════════════════════════════════════
#  STARTUP CHECKS
# ═══════════════════════════════════════════════════════════════════════

def check_config() -> bool:
    ok = True
    if not GEMINI_API_KEY:
        log.error("❌ GEMINI_API_KEY not set in config.json")
        ok = False
    if not [c for c in CAMERAS if c.get("enabled", True)]:
        log.error("❌ No cameras enabled in config.json")
        ok = False
    return ok


def check_wakelock():
    try:
        r = subprocess.run(
            ["pgrep", "-f", "termux-wake-lock"],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=3
        )
        if r.returncode == 0:
            log.info("🔒 Wakelock active")
        else:
            log.warning("⚠️  No wakelock! Run: termux-wake-lock")
    except Exception:
        log.info("💡 Tip: run termux-wake-lock")

# ═══════════════════════════════════════════════════════════════════════
#  MAIN
# ═══════════════════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(description="iCMOB AI Monitor v9")
    parser.add_argument("--test-cam", metavar="ID",
                        help="Test a camera: --test-cam cam1")
    parser.add_argument("--mock", action="store_true",
                        help="Mock mode with saved debug images")
    args = parser.parse_args()

    if args.test_cam:
        run_test(args.test_cam)
        return
    if args.mock:
        run_mock()
        return

    signal.signal(signal.SIGTERM, _sig_handler)
    signal.signal(signal.SIGINT,  _sig_handler)

    print("""
    ╔══════════════════════════════════════════╗
    ║     iCMOB AI Monitor v9                  ║
    ║     Guna's Home · Hyderabad              ║
    ║     Unattended · Self-Healing · 24/7     ║
    ╚══════════════════════════════════════════╝
    """)

    if not check_config():
        sys.exit(42)

    if not ping_gemini():
        log.error("Gemini failed — will retry on restart")
        sys.exit(1)

    _check_outage()
    check_wakelock()
    check_battery()
    free = check_disk(warn=True)
    cleanup_old()
    trim_log()

    enabled = [c for c in CAMERAS if c.get("enabled", True)]

    log.info("─" * 52)
    log.info(f"  Cameras     : {', '.join(c['name'] for c in enabled)}")
    log.info(f"  Model       : {_model}")
    log.info(f"  Monitoring  : {'24/7' if ACTIVE_HOURS is None else ACTIVE_HOURS}")
    log.info(f"  Scan        : {SCAN_INTERVAL}s + {LOITER_DELAY}s loiter")
    log.info(f"  Multi-frame : {MULTI_FRAMES} × {MULTI_INTERVAL_MS}ms")
    log.info(f"  Family      : {len(FAMILY_MEMBERS)} members")
    log.info(f"  Ntfy        : {'✅ ' + NTFY_TOPIC if NTFY_ENABLED else '❌'}")
    log.info(f"  Heartbeat   : every {HEARTBEAT_SEC//3600}h")
    log.info(f"  Disk        : {free:.0f} MB free")
    log.info("─" * 52)

    _replay_pending()
    Thread(target=bg_daily,     daemon=True, name="daily").start()
    Thread(target=bg_heartbeat, daemon=True, name="heartbeat").start()

    for cam in enabled:
        with _watcher_lock:
            w, t = _spawn(cam)
            _watchers[cam["id"]] = w
            _threads[cam["id"]]  = t
        time.sleep(2)

    Thread(target=health_monitor, args=(enabled,),
           daemon=True, name="health").start()

    _write_hb()
    log.info(f"✅ {len(enabled)} watchers running")
    log.info("Run 'termux-wake-lock' to prevent sleep!")

    names = ", ".join(c["name"] for c in enabled)
    with _model_lock:
        mn = _model
    _ntfy_simple(
        "iCMOB v9 Started ✅",
        f"{len(enabled)} cameras: {names}\n"
        f"Model: {mn} · {MULTI_FRAMES}-frame burst\n"
        f"Family: {len(FAMILY_MEMBERS)} members\n"
        f"Heartbeat: {HEARTBEAT_SEC//3600}h",
        tags="white_check_mark", priority="2"
    )

    _shutdown.wait()
    log.info("Shutting down...")
    _write_hb()
    _pool.shutdown(wait=True, cancel_futures=False)
    _ntfy_simple("iCMOB Stopped 🛑",
                 "Clean shutdown. Wrapper will restart.",
                 tags="octagonal_sign", priority="3")
    log.info("Done.")
    sys.exit(0)


if __name__ == "__main__":
    main()