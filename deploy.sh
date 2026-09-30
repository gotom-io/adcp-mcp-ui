#!/usr/bin/env bash
set -euo pipefail

REMOTE_HOST="gotom-adcp-mcp"
DEPLOY_TARGET="adcp-mcp-ui"

# Multiplex every ssh call over ONE master connection so the U2F/YubiKey
# touch happens only once per deploy. ControlPersist keeps the master alive
# for 30m after the last call — deploying right after the seller (whose
# deploy.sh uses the same ControlPath) reuses its master: no touch at all.
ssh() {
  command ssh \
    -o ControlMaster=auto \
    -o ControlPath="$HOME/.ssh/ctl-%r@%h-%p" \
    -o ControlPersist=30m \
    "$@"
}

# ── Deploy-Block ──────────────────────────────────────────────────────────────
# Pendant zu deployer/scripts/provision_blocked.txt, nur server-seitig: die Liste
# liegt auf dem Zielhost unter ${BLOCK_FILE} und gilt damit fuer jede Maschine und
# jeden Checkout (Blocken/Entblocken braucht keinen Commit). Geprueft wird VOR dem
# Build, damit ein Block nicht erst nach Minuten Bauzeit zuschlaegt.
# Format je Zeile (Felder durch Whitespace getrennt, # = Kommentar):
#   <target> <start> <end> <grund>
# <target> ist ein DEPLOY_TARGET ("sdk-adcp-seller" / "adcp-mcp-ui") oder "all" (ganzer Host).
# Zeitstempel muessen einzelne Shell-Tokens sein -> ISO mit T und Offset,
# z.B. 2026-09-10T00:00:00+02:00 (Offset, damit der Block nicht an der lokalen TZ haengt).
# Notfall-Override: DEPLOY_IGNORE_BLOCK=1 ./deploy.sh
BLOCK_FILE="/root/deploy_blocked.txt"

check_deploy_block() {
  local blocked now target start end reason start_ts end_ts

  if [ "${DEPLOY_IGNORE_BLOCK:-0}" = "1" ]; then
    echo "WARNUNG: DEPLOY_IGNORE_BLOCK=1 — Deploy-Block wird uebersprungen." >&2
    return 0
  fi

  blocked=$(ssh "${REMOTE_HOST}" "cat ${BLOCK_FILE} 2>/dev/null" || true)
  [ -n "${blocked}" ] || return 0

  now=$(date +%s)
  while read -r target start end reason; do
    [[ "${target}" =~ ^#|^$ ]] && continue
    [ "${target}" = "${DEPLOY_TARGET}" ] || [ "${target}" = "all" ] || continue
    [ -n "${end}" ] || continue
    start_ts=$(date -d "${start}" +%s 2>/dev/null) || continue
    end_ts=$(date -d "${end}" +%s 2>/dev/null) || continue

    if [ "${now}" -ge "${start_ts}" ] && [ "${now}" -lt "${end_ts}" ]; then
      echo "Deploy \"${DEPLOY_TARGET}\" auf ${REMOTE_HOST} blockiert bis ${end}${reason:+ (${reason})}." >&2
      echo "Liste: ${REMOTE_HOST}:${BLOCK_FILE}" >&2
      exit 1
    fi
  done <<< "${blocked}"
}

check_deploy_block

docker compose build app

echo Transfer "adcp-mcp-ui:latest" to "${REMOTE_HOST}" ...
docker save "adcp-mcp-ui:latest" | ssh "${REMOTE_HOST}" 'docker load'
echo ... done

ssh "${REMOTE_HOST}" "
  docker rm -f adcp-mcp-ui 2>/dev/null || true
  docker run -d \
    --name adcp-mcp-ui \
    --network sdk-adcp-net \
    --env-file /root/.adcp-mcp-ui.env \
    --restart unless-stopped \
    --volume /root/adcp-mcp-ui-logs:/app/logs \
    --volume /root/adcp-mcp-ui-secrets:/app/secrets \
    --memory="512m" \
    adcp-mcp-ui:latest
"
