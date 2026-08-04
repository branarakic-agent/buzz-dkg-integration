#!/usr/bin/env bash
# Operator example: restart a DKG node only after repeated slow/unreachable
# probes. Every host-specific path, graph, and service identity is explicit.
set -u

API=${WATCHDOG_DKG_API:-http://127.0.0.1:9200}
CG=${WATCHDOG_CONTEXT_GRAPH_ID:-}
TOKEN_PATH=${WATCHDOG_TOKEN_PATH:-${DKG_HOME:-$HOME/.dkg}/auth.token}
STATE_DIR=${WATCHDOG_STATE_DIR:-$HOME/.local/state/buzz-dkg-watchdog}
LOG=${WATCHDOG_LOG:-$STATE_DIR/watchdog.log}
NODE_LOG=${WATCHDOG_NODE_LOG:-}
EVIDENCE_DIR=${WATCHDOG_EVIDENCE_DIR:-$STATE_DIR/evidence}
SLOW_SECONDS=${WATCHDOG_SLOW_SECONDS:-8}
FAILURES_REQUIRED=${WATCHDOG_FAILURES_REQUIRED:-3}
MAX_RESTARTS_PER_HOUR=${WATCHDOG_MAX_RESTARTS_PER_HOUR:-3}
BACKOFF_BASE_SECONDS=${WATCHDOG_BACKOFF_BASE_SECONDS:-300}
EVIDENCE_RETENTION_DAYS=${WATCHDOG_EVIDENCE_RETENTION_DAYS:-7}

ts() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }
die() { printf '%s watchdog configuration error: %s\n' "$(ts)" "$*" >&2; exit 2; }
integer() { [[ "$2" =~ ^[0-9]+$ ]] || die "$1 must be a non-negative integer"; }

[[ -n "$CG" ]] || die 'WATCHDOG_CONTEXT_GRAPH_ID is required'
[[ -r "$TOKEN_PATH" ]] || die "token is not readable: $TOKEN_PATH"
TOKEN=$(grep -v '^[[:space:]]*#' "$TOKEN_PATH" | awk 'NF { value=$0 } END { print value }')
[[ -n "$TOKEN" ]] || die "token file contains no token: $TOKEN_PATH"
integer WATCHDOG_FAILURES_REQUIRED "$FAILURES_REQUIRED"
integer WATCHDOG_MAX_RESTARTS_PER_HOUR "$MAX_RESTARTS_PER_HOUR"
integer WATCHDOG_BACKOFF_BASE_SECONDS "$BACKOFF_BASE_SECONDS"
integer WATCHDOG_EVIDENCE_RETENTION_DAYS "$EVIDENCE_RETENTION_DAYS"
[[ "$FAILURES_REQUIRED" -ge 2 ]] || die 'WATCHDOG_FAILURES_REQUIRED must be at least 2'
[[ -n "${WATCHDOG_SYSTEMD_UNIT:-}" || -n "${WATCHDOG_LAUNCHD_LABEL:-}" ]] ||
  die 'set WATCHDOG_SYSTEMD_UNIT or WATCHDOG_LAUNCHD_LABEL'

mkdir -p "$STATE_DIR" "$EVIDENCE_DIR"
FAILURE_FILE=$STATE_DIR/consecutive-failures
RESTARTS_FILE=$STATE_DIR/restarts.epoch
LAST_RESTART_FILE=$STATE_DIR/last-restart.epoch
touch "$LOG" "$RESTARTS_FILE"
find "$EVIDENCE_DIR" -type f -name 'storm-evidence-*.log' -mtime "+$EVIDENCE_RETENTION_DAYS" -delete

payload=$(printf '%s' "$CG" | sed 's/\\/\\\\/g; s/"/\\"/g')
probe=$(curl --silent --show-error --max-time 15 --request POST "$API/api/query" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"contextGraphId":"'"$payload"'","view":"shared-working-memory","sparql":"SELECT (COUNT(*) AS ?n) WHERE {?s ?p ?o}"}' \
  -o /dev/null -w '%{http_code} %{time_total}' 2>>"$LOG")
curl_status=$?
CODE=${probe%% *}
SECS=${probe##* }
SLOW=$(awk -v seconds="$SECS" -v limit="$SLOW_SECONDS" 'BEGIN { print (seconds+0 > limit+0) ? 1 : 0 }')

if [[ "$curl_status" -eq 0 && "$CODE" == 200 && "$SLOW" == 0 ]]; then
  printf '0\n' > "$FAILURE_FILE"
  printf '%s ok %ss\n' "$(ts)" "$SECS" >> "$LOG"
  exit 0
fi

if [[ "$CODE" == 401 || "$CODE" == 403 ]]; then
  printf '%s auth failure HTTP %s; refusing restart\n' "$(ts)" "$CODE" >> "$LOG"
  exit 2
fi
if [[ "$curl_status" -eq 0 && "$CODE" =~ ^4 ]]; then
  printf '%s non-restartable client error HTTP %s; check probe configuration\n' "$(ts)" "$CODE" >> "$LOG"
  exit 2
fi

failures=0
[[ -r "$FAILURE_FILE" ]] && read -r failures < "$FAILURE_FILE"
[[ "$failures" =~ ^[0-9]+$ ]] || failures=0
failures=$((failures + 1))
printf '%s\n' "$failures" > "$FAILURE_FILE"
printf '%s probe failure %s/%s code=%s curl=%s t=%ss\n' \
  "$(ts)" "$failures" "$FAILURES_REQUIRED" "${CODE:-000}" "$curl_status" "${SECS:-0}" >> "$LOG"
[[ "$failures" -ge "$FAILURES_REQUIRED" ]] || exit 1

now=$(date +%s)
hour_ago=$((now - 3600))
recent_restarts=$(awk -v cutoff="$hour_ago" '$1 >= cutoff { count++ } END { print count+0 }' "$RESTARTS_FILE")
if [[ "$recent_restarts" -ge "$MAX_RESTARTS_PER_HOUR" ]]; then
  printf '%s restart cap reached (%s/hour); alerting without action\n' "$(ts)" "$MAX_RESTARTS_PER_HOUR" >> "$LOG"
  exit 2
fi

last_restart=0
[[ -r "$LAST_RESTART_FILE" ]] && read -r last_restart < "$LAST_RESTART_FILE"
[[ "$last_restart" =~ ^[0-9]+$ ]] || last_restart=0
backoff=$((BACKOFF_BASE_SECONDS * (1 << recent_restarts)))
(( backoff > 3600 )) && backoff=3600
if (( now - last_restart < backoff )); then
  printf '%s restart backoff active (%ss); leaving node untouched\n' "$(ts)" "$backoff" >> "$LOG"
  exit 1
fi

SNAP=$EVIDENCE_DIR/storm-evidence-$now.log
{
  printf '=== watchdog trigger %s: code=%s curl=%s t=%ss failures=%s ===\n' \
    "$(ts)" "${CODE:-000}" "$curl_status" "${SECS:-0}" "$failures"
  if [[ -n "$NODE_LOG" && -r "$NODE_LOG" ]]; then tail -200 "$NODE_LOG"; else echo 'node log not configured/readable'; fi
} > "$SNAP"

if [[ -n "${WATCHDOG_SYSTEMD_UNIT:-}" ]]; then
  systemctl restart "$WATCHDOG_SYSTEMD_UNIT"
else
  launchctl kickstart -k "gui/$(id -u)/$WATCHDOG_LAUNCHD_LABEL"
fi
restart_status=$?
if [[ "$restart_status" -ne 0 ]]; then
  printf '%s restart command failed status=%s (evidence: %s)\n' "$(ts)" "$restart_status" "$SNAP" >> "$LOG"
  exit 2
fi
printf '%s\n' "$now" >> "$RESTARTS_FILE"
printf '%s\n' "$now" > "$LAST_RESTART_FILE"
printf '0\n' > "$FAILURE_FILE"
printf '%s restarted after %s failures (evidence: %s)\n' "$(ts)" "$failures" "$SNAP" >> "$LOG"
