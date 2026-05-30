#!/data/data/com.termux/files/usr/bin/bash
# ═══════════════════════════════════════════════════════════════════════
#  iCMOB v9 — Self-Healing Wrapper
#  ────────────────────────────────
#  Handles: wakelock, WiFi wait (indefinite), DVR wait, crash recovery
#
#  This script NEVER gives up. If WiFi is down for a day, it waits.
#  When power/WiFi returns, it auto-starts everything.
#
#  Place in: ~/.termux/boot/start_icmob.sh (for auto-boot)
#  Or run:   bash ~/start_icmob.sh
# ═══════════════════════════════════════════════════════════════════════
SCRIPT="$HOME/icmob_ai.py"
LOG_FILE="$HOME/icmob_ai/logs/wrapper.log"
DVR_IP="192.168.0.100"
RESTART_DELAY=10
mkdir -p "$HOME/icmob_ai/logs"
log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') [WRAPPER] $1" | tee -a "$LOG_FILE"
}
# ── Wakelock ──────────────────────────────────────────────────────────
log "Acquiring termux wakelock..."
termux-wake-lock 2>/dev/null
log "Wakelock acquired"
# ── Wait for internet — INDEFINITE, never gives up ───────────────────
wait_for_network() {
    log "Waiting for internet..."
    local waited=0
    local backoff=5
    while true; do
        if ping -c 1 -W 3 8.8.8.8 >/dev/null 2>&1; then
            log "✅ Internet is up (waited ${waited}s)"
            return 0
        fi
        sleep $backoff
        waited=$((waited + backoff))
        # Log every 2 minutes
        if [ $((waited % 120)) -eq 0 ]; then
            log "Still waiting for internet... (${waited}s / $(( waited / 3600 ))h $(( (waited % 3600) / 60 ))m)"
        fi
        # Increase backoff: 5s → 10s → 30s → 60s (cap)
        if [ $waited -gt 300 ]; then
            backoff=60
        elif [ $waited -gt 60 ]; then
            backoff=30
        elif [ $waited -gt 30 ]; then
            backoff=10
        fi
    done
}
# ── Wait for DVR — tries for 10 minutes, then starts anyway ──────────
wait_for_dvr() {
    log "Waiting for DVR at $DVR_IP..."
    local waited=0
    local max_wait=600   # 10 minutes
    while [ $waited -lt $max_wait ]; do
        if ping -c 1 -W 3 "$DVR_IP" >/dev/null 2>&1; then
            log "✅ DVR reachable (waited ${waited}s)"
            log "Waiting 20s for DVR RTSP to initialize..."
            sleep 20
            return 0
        fi
        sleep 10
        waited=$((waited + 10))
        if [ $((waited % 60)) -eq 0 ]; then
            log "Still waiting for DVR... (${waited}s)"
        fi
    done
    log "⚠️ DVR not reachable after ${max_wait}s — starting anyway (will retry in script)"
    return 1
}
# ── Forever loop ──────────────────────────────────────────────────────
log "════════════════════════════════════════════"
log "  iCMOB v9 Wrapper — Starting"
log "════════════════════════════════════════════"
RESTART_COUNT=0
while true; do
    RESTART_COUNT=$((RESTART_COUNT + 1))
    # Always wait for network before starting/restarting
    wait_for_network
    wait_for_dvr
    if [ $RESTART_COUNT -eq 1 ]; then
        log "Starting iCMOB AI Monitor (first run)..."
    else
        log "Restarting iCMOB AI Monitor (restart #$((RESTART_COUNT - 1)))..."
    fi
    # Run the script
    python "$SCRIPT" 2>&1 | tee -a "$LOG_FILE"
    EXIT_CODE=$?
    log "iCMOB exited with code $EXIT_CODE"
    # Exit code 0 = clean shutdown (user pressed Ctrl+C) — don't restart
    if [ $EXIT_CODE -eq 0 ]; then
        log "Clean exit (code 0) — not restarting"
        break
    fi
    # Exit code 42 = config error, don't spam restarts
    if [ $EXIT_CODE -eq 42 ]; then
        log "Config error — fix config.json and restart manually"
        break
    fi
    # Crash — restart with backoff
    DELAY=$RESTART_DELAY
    if [ $RESTART_COUNT -gt 10 ]; then
        DELAY=300   # 5 min after 10 crashes
    elif [ $RESTART_COUNT -gt 5 ]; then
        DELAY=60    # 1 min after 5 crashes
    fi
    log "Crash detected — restarting in ${DELAY}s..."
    sleep $DELAY
done
log "Wrapper exited"