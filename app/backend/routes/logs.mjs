// GET /api/logs?query=... - Proxy to the MCP server's getLogs tool.

import { getLogger } from '../logger.mjs';
import { getHeaderInfo, sendJson, sendError } from '../http-utils.mjs';
import { getHttpClientTools, buildCacheKey } from '../mcp-client.mjs';

const MAX_LINES_RETURNED = 2000;

export const handleGetLogs = async (req, res, url) => {
  const headerCheck = getHeaderInfo(req, res);
  if (!headerCheck.ok) return;

  const { adcpAuth, mcpServerUrl, sessionId } = headerCheck.info;
  const logger = getLogger(sessionId);
  const query = url.searchParams.get('query') || '';
  const cacheKey = buildCacheKey(adcpAuth, mcpServerUrl, sessionId);

  try {
    const tools = await getHttpClientTools(cacheKey, adcpAuth, mcpServerUrl);
    const getLogsTool = tools.getLogs;

    if (!getLogsTool) {
      return sendError(res, 404, 'getLogs tool not found');
    }

    logger.debug('Calling getLogs MCP tool');
    const result = await getLogsTool.execute({
      searchString: query,
      maxLinesReturned: MAX_LINES_RETURNED,
    });

    sendJson(res, 200, result);
  } catch (err) {
    logger.error('Error fetching logs:', err);
    sendError(res, 500, err.message || String(err));
  }
};
