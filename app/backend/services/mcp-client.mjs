import { createMCPClient } from '@ai-sdk/mcp';
import NodeCache from 'node-cache';
import { getMcpSessionIdShort } from "../../shared/shared.mjs";

const httpClientToolsCache = new NodeCache({ stdTTL: 3600 * 12, checkperiod: 1800, useClones: false });
const cacheKeySeparator = '___';

export const getHttpClientTools = async function(cacheKey, adcpAuth, mcpServerUrl) {
  let clientTools = httpClientToolsCache.get(cacheKey);
  if (clientTools) {
    return clientTools;
  }

  const sessionId = cacheKey.split(cacheKeySeparator)[2];
  const xMcpSessionId = getMcpSessionIdShort(sessionId);
  const httpClient = await createMCPClient({
    transport: {
      type: 'http',
      url: mcpServerUrl,
      headers: {
        'x-adcp-auth': adcpAuth,
        'x-mcp-session-id': xMcpSessionId,
        'Authorization': `Basic ${ Buffer.from(`${ process.env.BASIC_AUTH_USER }:${ process.env.BASIC_AUTH_PASS }`).toString('base64') }`
      },
    },
  });
  clientTools = await httpClient.tools();
  httpClientToolsCache.set(cacheKey, clientTools);
  return clientTools;
}
