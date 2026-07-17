#!/usr/bin/env bash
set -euo pipefail

REMOTE_HOST="gotom-adcp-mcp"

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
