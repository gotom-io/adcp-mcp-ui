import NodeCache from 'node-cache';
import { getMcpSessionIdShort } from "../shared.mjs";
import { createMCPClient } from '@ai-sdk/mcp';

const cacheKeySeparator = '___';

const httpClientToolsCache = new NodeCache({ stdTTL: 3600 * 12, checkperiod: 1800, useClones: false });
const contextHistoryCache = new NodeCache({ stdTTL: 3600 * 12, checkperiod: 1800, useClones: false });

const MAX_CONTEXT_CHARS = 200_000;

// Get context history for a user session
const getContextHistory = (cacheKey) => {
  return contextHistoryCache.get(cacheKey) || [];
};

// Add message to context history and trim if needed
const addToContextHistory = (cacheKey, role, content) => {
  const history = getContextHistory(cacheKey);
  history.push({ role, content });

  const countHistorySize = () => {
    return history.reduce((sum, msg) => sum + msg.content.length, 0);
  };

  // Trim history if total chars exceed limit
  let totalChars = countHistorySize();
  let messagesRemoved = 0;

  while (totalChars > MAX_CONTEXT_CHARS && history.length > 1) {
    const removed = history.shift();
    totalChars -= removed.content.length;
    messagesRemoved++;
  }

  contextHistoryCache.set(cacheKey, history);
  return { history, messagesRemoved };
};

const clearContextHistory = (cacheKey) => {
  contextHistoryCache.del(cacheKey);
};

const getHttpClientTools = async function(cacheKey, adcpAuth, mcpServerUrl, getLogger) {
  let clientTools = httpClientToolsCache.get(cacheKey);
  if (clientTools) {
    return clientTools;
  }

  const sessionId = cacheKey.split(cacheKeySeparator)[2];
  const xMcpSessionId = getMcpSessionIdShort(sessionId);
  
  const logger = getLogger(sessionId);
  
  const httpClient = await createMCPClient({
    transport: {
      type: 'http',
      url: mcpServerUrl,
      headers: {
        'x-adcp-auth': adcpAuth,
        'x-mcp-session-id': xMcpSessionId,
        'Authorization': `Basic ${Buffer.from(`${process.env.BASIC_AUTH_USER}:${process.env.BASIC_AUTH_PASS}`).toString('base64')}`
      },
    },
  });
  
  clientTools = await httpClient.tools();
  httpClientToolsCache.set(cacheKey, clientTools);
  return clientTools;
};

export {
  cacheKeySeparator,
  MAX_CONTEXT_CHARS,
  getContextHistory,
  addToContextHistory,
  clearContextHistory,
  getHttpClientTools,
  httpClientToolsCache,
  contextHistoryCache
};
