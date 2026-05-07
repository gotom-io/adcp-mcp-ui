import NodeCache from 'node-cache';
import { createMCPClient } from '@ai-sdk/mcp';
import { getMcpSessionIdShort } from '../shared/session.mjs';

export const cacheKeySeparator = '___';

const httpClientToolsCache = new NodeCache({
  stdTTL: 3600 * 12,
  checkperiod: 1800,
  useClones: false,
});

export const buildCacheKey = (adcpAuth, mcpServerUrl, sessionId) =>
  `${adcpAuth}${cacheKeySeparator}${mcpServerUrl}${cacheKeySeparator}${sessionId}`;

const buildBasicAuth = () => {
  const user = process.env.BASIC_AUTH_USER || '';
  const pass = process.env.BASIC_AUTH_PASS || '';
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
};

export const getHttpClientTools = async (cacheKey, adcpAuth, mcpServerUrl) => {
  const cached = httpClientToolsCache.get(cacheKey);
  if (cached) return cached;

  const sessionId = cacheKey.split(cacheKeySeparator)[2];
  const xMcpSessionId = getMcpSessionIdShort(sessionId);

  const client = await createMCPClient({
    transport: {
      type: 'http',
      url: mcpServerUrl,
      headers: {
        'x-adcp-auth': adcpAuth,
        'x-mcp-session-id': xMcpSessionId,
        Authorization: buildBasicAuth(),
      },
    },
  });

  const tools = await client.tools();
  httpClientToolsCache.set(cacheKey, tools);
  return tools;
};
