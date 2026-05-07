import NodeCache from 'node-cache';

const MAX_CONTEXT_CHARS = 200_000;
const contextHistoryCache = new NodeCache({ stdTTL: 3600 * 12, checkperiod: 1800, useClones: false });

export const getContextHistory = (cacheKey) => {
  return contextHistoryCache.get(cacheKey) || [];
};

export const addToContextHistory = (cacheKey, role, content) => {
  const history = getContextHistory(cacheKey);
  history.push({ role, content });

  function countHistorySize() {
    return history.reduce((sum, msg) => sum + msg.content.length, 0);
  }

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

export const clearContextHistory = (cacheKey) => {
  contextHistoryCache.del(cacheKey);
};
