import NodeCache from 'node-cache';

const MAX_CONTEXT_CHARS = 200_000;

const cache = new NodeCache({ stdTTL: 3600 * 12, checkperiod: 1800, useClones: false });

const totalChars = (history) =>
  history.reduce((sum, msg) => sum + msg.content.length, 0);

export const getContextHistory = (cacheKey) => cache.get(cacheKey) || [];

export const clearContextHistory = (cacheKey) => cache.del(cacheKey);

/**
 * Append a message and trim oldest messages until the total fits MAX_CONTEXT_CHARS.
 * Returns the (possibly trimmed) history along with how many messages were removed.
 */
export const addToContextHistory = (cacheKey, role, content) => {
  const history = getContextHistory(cacheKey);
  history.push({ role, content });

  let messagesRemoved = 0;
  while (totalChars(history) > MAX_CONTEXT_CHARS && history.length > 1) {
    history.shift();
    messagesRemoved++;
  }

  cache.set(cacheKey, history);
  return { history, messagesRemoved };
};
