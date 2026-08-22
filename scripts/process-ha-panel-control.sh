#!/bin/sh
set -eu

config=/etc/hosting-control/ha-panel-control.env
[ -r "$config" ] || exit 0
# shellcheck disable=SC1090
. "$config"

request="$HA_PANEL_DATA_DIR/ha-control-request.json"
result="$HA_PANEL_DATA_DIR/ha-control-result.json"
processing="$HA_PANEL_DATA_DIR/ha-control-request.processing.json"
role_file=/etc/hosting-control/role.json
mkdir -p "$HA_PANEL_DATA_DIR"
exec 9>/run/hosting-ha-panel-control.lock
flock -n 9 || exit 0
[ -f "$request" ] || [ -f "$processing" ] || exit 0
if [ ! -f "$processing" ]; then mv "$request" "$processing"; fi

finish() {
  status=$1 message=$2
  temporary="$result.tmp.$$"
  jq -n --arg id "$id" --arg action "$action" --arg status "$status" --arg message "$message" \
    --arg completedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{version:1,id:$id,action:$action,status:$status,message:$message,completedAt:$completedAt}' > "$temporary"
  chmod 0644 "$temporary"
  mv "$temporary" "$result"
  rm -f "$processing"
}

if ! jq -e '.version == 1 and (.id|type == "string") and (.action|type == "string") and (.serverId|type == "string")' "$processing" >/dev/null 2>&1; then
  id=invalid action=invalid
  finish rejected "Invalid HA control request"
  exit 0
fi
id=$(jq -r '.id' "$processing")
action=$(jq -r '.action' "$processing")
requested_server=$(jq -r '.serverId' "$processing")
role=$(jq -r '.role // empty' "$role_file" 2>/dev/null || true)
server=$(jq -r '.server_id // .serverId // empty' "$role_file" 2>/dev/null || true)
if [ -z "$server" ] || [ "$requested_server" != "$server" ]; then
  finish rejected "Server identity changed before the request was processed"
  exit 0
fi

unit=
case "$role:$action" in
  primary:replicate-now) unit=hosting-database-replication.service ;;
  standby:finalize-standby) unit=hosting-warm-sync-finalizer.service ;;
  standby:failover-check) unit=hosting-automatic-failover.service ;;
  *) finish rejected "Action is not allowed for the current machine role"; exit 0 ;;
esac

unit_state=$(systemctl show "$unit" --property=ActiveState --value 2>/dev/null || true)
if [ "$unit_state" = active ] || [ "$unit_state" = activating ] || [ "$unit_state" = reloading ]; then
  finish succeeded "$unit is already running"
elif systemctl start "$unit"; then
  finish succeeded "$unit completed"
else
  finish failed "$unit failed"
fi
