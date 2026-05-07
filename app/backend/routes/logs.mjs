import { getHeaderInfo } from '../utils.mjs';
import { getHttpClientTools, cacheKeySeparator } from '../cache.mjs';
import { createLogger } from '../logger.mjs';

const getLogs = async (req, res) => {
  const headerInfo = getHeaderInfo(req, res);

  if (res === headerInfo) {
    return; // error already sent
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const query = url.searchParams.get('query') || '';

  const { adcpAuth, mcpServerUrl, sessionId } = headerInfo;
  const logger = createLogger(sessionId);

  const cacheKey = `${adcpAuth}${cacheKeySeparator}${mcpServerUrl}${cacheKeySeparator}${sessionId}`;

  try {
    const tools = await getHttpClientTools(cacheKey, adcpAuth, mcpServerUrl, createLogger);
    const getLogsTool = tools.getLogs;

    if (!getLogsTool) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'getLogs tool not found' }));
      return;
    }

    logger.debug('Calling getLogs MCP tool');

    const result = await getLogsTool.execute({ searchString: query, maxLinesReturned: 2000 });

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result));

  } catch (err) {
    logger.error('Error fetching logs:', err);

    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: err.message || String(err) }));
  }
};

export { getLogs };
