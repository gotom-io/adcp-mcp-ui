#!/usr/bin/env bash
set -euo pipefail

REMOTE_HOST="gotom-adcp-mcp"

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
