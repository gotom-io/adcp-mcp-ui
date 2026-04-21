#!/usr/bin/env bash
set -euo pipefail

REMOTE_HOST="gotom-adcp-mcp"
IMAGE_NAME_MCP_UI="adcp-mcp-ui:latest"

docker compose build app

echo Transfer "${IMAGE_NAME_MCP_UI}" to "${REMOTE_HOST}" ...
docker save "${IMAGE_NAME_MCP_UI}" | ssh "${REMOTE_HOST}" 'docker load'
echo ... done

ssh "${REMOTE_HOST}" "
  docker rm -f adcp-mcp-ui 2>/dev/null || true
  docker run -d \
    --name adcp-mcp-ui \
    --network adcp-net \
    --env-file /root/.adcp-mcp-ui.env \
    --restart unless-stopped \
    --volume /root/adcp-mcp-ui-logs:/app/logs \
    ${IMAGE_NAME_MCP_UI}
"
