"""
Home Guard Dashboard API
════════════════════════
Lightweight Flask bridge between the iCMOB monitor (icmob_ai.py) and the
React dashboard. Serves events, status, config, snapshots, and a manual
family-alert button. Runs on the same phone/mini-PC as the monitor.

Run:  python dashboard_api.py      (listens on 0.0.0.0:5000)
"""

import io
import json
import os
import urllib.request as urlreq
from datetime import datetime, timedelta

from flask import Flask, jsonify, request, send_file

app = Flask(__name__)

# ── Paths: match icmob_ai.py exactly so we read the SAME files ──────────
HOME      = os.path.expanduser("~")
BASE_DIR  = os.path.join(HOME, "icmob_ai")
EVENTS_FILE = os.path.join(BASE_DIR, "logs", "events.jsonl")
SNAP_DIR    = os.path.join(BASE_DIR, "snapshots")

_CONFIG_CANDIDATES = [
    os.path.join(BASE_DIR, "config.json"),
    os.path.join(HOME, "config.json"),
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json"),
]


def _config_path() -> str:
    for p in _CONFIG_CANDIDATES:
        if os.path.exists(p):
            return p
    return _CONFIG_CANDIDATES[-1]


# ── CORS: allow the React dashboard to talk to this device ──────────────
@app.after_request
def after_request(response):
    response.headers.add('Access-Control-Allow-Origin', '*')
    response.headers.add('Access-Control-Allow-Headers', 'Content-Type,Authorization')
    response.headers.add('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS')
    return response


@app.before_request
def handle_options():
    if request.method == 'OPTIONS':
        return jsonify({}), 200


# ── Helpers ─────────────────────────────────────────────────────────────

def _read_config() -> dict:
    path = _config_path()
    if not os.path.exists(path):
        return {}
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {}


def _write_config(config: dict):
    path = _config_path()
    tmp = path + ".tmp"
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(config, f, indent=2, ensure_ascii=False)
    os.replace(tmp, path)


def _get_system_status() -> dict:
    config = _read_config()
    is_active = config.get("monitoring", {}).get("active", True)
    snooze    = config.get("monitoring", {}).get("snooze_until", None)
    return {"status": "Active" if is_active else "Off", "snooze_until": snooze}


def _ntfy_publish(server: str, topic: str, token: str,
                  title: str, message: str,
                  priority: int = 5, tags=None) -> None:
    """UTF-8 safe publish via ntfy JSON endpoint (handles Telugu + emoji)."""
    payload = {
        "topic":    topic,
        "title":    title,
        "message":  message,
        "priority": int(priority),
        "tags":     tags or ["rotating_light"],
    }
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urlreq.Request(
        server,                                   # JSON publish → root URL
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    urlreq.urlopen(req, timeout=10)


# ── Events ───────────────────────────────────────────────────────────────

@app.route('/api/events', methods=['GET'])
def get_events():
    events = []
    if os.path.exists(EVENTS_FILE):
        with open(EVENTS_FILE, 'r', encoding='utf-8') as f:
            for line in f:
                if line.strip():
                    try:
                        events.append(json.loads(line.strip()))
                    except Exception:
                        continue
    events.reverse()   # newest first
    return jsonify(events)


@app.route('/api/events/purge', methods=['POST', 'OPTIONS'])
def purge_old_events():
    days = 7
    if request.is_json:
        days = request.json.get("days", 7)

    cutoff = datetime.now() - timedelta(days=days)
    kept, removed = [], 0

    if os.path.exists(EVENTS_FILE):
        with open(EVENTS_FILE, 'r', encoding='utf-8') as f:
            for line in f:
                if not line.strip():
                    continue
                try:
                    event = json.loads(line.strip())
                    ts_str = event.get("timestamp", "")
                    ts = None
                    for fmt in ("%Y-%m-%dT%H:%M:%S.%f", "%Y-%m-%dT%H:%M:%S",
                                "%Y-%m-%d %H:%M:%S", "%I:%M %p"):
                        try:
                            ts = datetime.strptime(ts_str.split("+")[0], fmt)
                            break
                        except ValueError:
                            continue
                    if ts is None or ts >= cutoff:
                        kept.append(line)
                    else:
                        removed += 1
                except Exception:
                    kept.append(line)

        with open(EVENTS_FILE, 'w', encoding='utf-8') as f:
            f.writelines(kept)

    return jsonify({"removed": removed, "remaining": len(kept)})


# ── Snapshots ─────────────────────────────────────────────────────────────

@app.route('/api/snapshot/<event_id>', methods=['GET'])
def get_snapshot(event_id: str):
    """Serve the JPEG for an event. event_id looks like 'cam1_1700000000'."""
    safe = os.path.basename(event_id)            # block path traversal
    cam_id = safe.split("_")[0]
    path = os.path.join(SNAP_DIR, cam_id, f"{safe}.jpg")
    if not os.path.exists(path):
        return jsonify({"error": "snapshot not found"}), 404
    return send_file(path, mimetype="image/jpeg")


# ── Status & Toggle ────────────────────────────────────────────────────────

@app.route('/api/status', methods=['GET'])
def status():
    return jsonify(_get_system_status())


@app.route('/api/toggle', methods=['POST', 'OPTIONS'])
def toggle_system():
    config = _read_config()
    if not config:
        return jsonify({"error": "config.json missing"}), 404
    try:
        current = config.get("monitoring", {}).get("active", True)
        config.setdefault("monitoring", {})["active"] = not current
        _write_config(config)
        return jsonify({"status": "Off" if current else "Active"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── Config GET / PUT ────────────────────────────────────────────────────────

@app.route('/api/config', methods=['GET'])
def get_config():
    config = _read_config()
    if not config:
        return jsonify({"error": "config.json missing"}), 404

    mon    = config.get("monitoring", {})
    ntfy   = config.get("ntfy", {})
    gemini = config.get("gemini", {})
    notif  = config.get("notifications", {})

    return jsonify({
        "cameras": [
            {
                "id":               c.get("id"),
                "name":             c.get("name"),
                "location":         c.get("location"),
                "enabled":          c.get("enabled", True),
                "motion_threshold": c.get("motion_threshold", 8.0),
            }
            for c in config.get("cameras", [])
        ],
        "monitoring": {
            "active":               mon.get("active", True),
            "scan_interval_sec":    mon.get("scan_interval_sec", 15),
            "min_alert_gap_sec":    mon.get("min_alert_gap_sec", 60),
            "active_hours":         mon.get("active_hours", [6, 23]),
            "night_mode":           mon.get("night_mode", False),
            "event_log_keep_days":  mon.get("event_log_keep_days", 90),
        },
        "ntfy": {
            "enabled": ntfy.get("enabled", False),
            "server":  ntfy.get("server", "https://ntfy.sh"),
            "topic":   ntfy.get("topic", ""),
        },
        "gemini": {
            "model":       gemini.get("model", "gemini-2.5-flash"),
            "temperature": gemini.get("temperature", 0.4),
        },
        "notifications": {
            "languages":       notif.get("languages", ["en", "te"]),
            "attach_snapshot": notif.get("attach_snapshot", True),
        },
        "family_members": config.get("family_members", []),
    })


@app.route('/api/config', methods=['PUT', 'OPTIONS'])
def update_config():
    if not request.is_json:
        return jsonify({"error": "Content-Type must be application/json"}), 400

    updates = request.get_json()
    config  = _read_config()
    if not config:
        return jsonify({"error": "config.json missing"}), 404

    try:
        # ── Monitoring ──
        if "monitoring" in updates:
            config.setdefault("monitoring", {})
            for key in ["night_mode", "active_hours", "scan_interval_sec",
                        "min_alert_gap_sec", "event_log_keep_days"]:
                if key in updates["monitoring"]:
                    config["monitoring"][key] = updates["monitoring"][key]

        # ── Notifications ──
        if "ntfy" in updates:
            config.setdefault("ntfy", {})
            for key in ["enabled"]:
                if key in updates["ntfy"]:
                    config["ntfy"][key] = updates["ntfy"][key]

        # ── Languages (English / Telugu) ──
        if "notifications" in updates:
            config.setdefault("notifications", {})
            for key in ["languages", "attach_snapshot"]:
                if key in updates["notifications"]:
                    config["notifications"][key] = updates["notifications"][key]

        # ── Per-camera thresholds ──
        if "cameras" in updates:
            cam_map = {c["id"]: c for c in updates["cameras"] if "id" in c}
            for cam in config.get("cameras", []):
                if cam.get("id") in cam_map:
                    upd = cam_map[cam["id"]]
                    if "motion_threshold" in upd:
                        cam["motion_threshold"] = round(float(upd["motion_threshold"]), 1)
                    if "enabled" in upd:
                        cam["enabled"] = bool(upd["enabled"])

        _write_config(config)
        return jsonify({"ok": True, "message": "Settings saved. Restart camera script to apply."})

    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── Manual Alert via ntfy (bilingual) ────────────────────────────────────────

@app.route('/api/alert', methods=['POST', 'OPTIONS'])
def send_alert():
    config   = _read_config()
    ntfy_cfg = config.get("ntfy", {})

    if not ntfy_cfg.get("enabled"):
        return jsonify({"error": "ntfy notifications are disabled in config"}), 400

    server = ntfy_cfg.get("server", "https://ntfy.sh")
    topic  = ntfy_cfg.get("topic", "")
    token  = ntfy_cfg.get("token", "")

    if not topic:
        return jsonify({"error": "ntfy topic not set in config"}), 400

    body    = request.get_json(silent=True) or {}
    title   = body.get("title") or "Home Guard — Family Alert"
    message = body.get("message") or (
        "🚨 Manual alert from Home Guard dashboard\n"
        "🚨 హోమ్ గార్డ్ నుండి అత్యవసర హెచ్చరిక"
    )

    try:
        _ntfy_publish(server, topic, token, title, message,
                      priority=5, tags=["rotating_light"])
        return jsonify({"ok": True, "message": "Alert sent to all family devices ✓"})
    except Exception as e:
        return jsonify({"error": f"ntfy failed: {str(e)}"}), 500


# ── Cameras list ─────────────────────────────────────────────────────────────

@app.route('/api/cameras', methods=['GET'])
def get_cameras():
    config = _read_config()
    return jsonify([
        {
            "id":               c.get("id"),
            "name":             c.get("name"),
            "location":         c.get("location"),
            "enabled":          c.get("enabled", True),
            "motion_threshold": c.get("motion_threshold", 8.0),
            "status":           "online" if c.get("enabled", True) else "offline",
        }
        for c in config.get("cameras", [])
    ])


# ── Run ─────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    print("✅ Home Guard API running on http://0.0.0.0:5000")
    print(f"   events: {EVENTS_FILE}")
    print(f"   config: {_config_path()}")
    app.run(host='0.0.0.0', port=5000, debug=False)