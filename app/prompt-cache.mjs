/**
 * Anthropic prompt caching for the chat request (GOT-13131).
 *
 * The cache is a byte-exact prefix match over tools -> system -> messages, and
 * a cache entry only exists where a request set a breakpoint. Two are set:
 *
 * 1. On the system prompt. Tools render before it, so this one entry holds the
 *    MCP tool schemas plus the system prompt — identical for every session
 *    against the same seller, and the bulk of every request.
 * 2. On the message that starts the turn. The steps of a turn (one request per
 *    tool round) and the next turn re-send the conversation up to here.
 *
 * What a turn's own tool rounds append is deliberately left unmarked: a write
 * costs 1.25x the input price and only pays off when it is read again within
 * five minutes. The last round of a turn never is, because tool results are
 * not kept in the history.
 *
 * Nothing here is sent on a timer — a cache write is only ever part of a
 * request the user triggered.
 */
const EPHEMERAL = { anthropic: { cacheControl: { type: 'ephemeral' } } };

/** The system prompt as a message that carries the first breakpoint. */
export function cachedSystemMessage(prompt) {
  return { role: 'system', content: prompt, providerOptions: EPHEMERAL };
}

/**
 * A copy of the history whose last message carries the second breakpoint.
 *
 * A copy, because the history array is the session's stored one: marking it in
 * place would leave a breakpoint behind on every turn, and Anthropic accepts
 * four per request.
 */
export function withTurnBreakpoint(messages) {
  if (messages.length === 0) return messages;
  const last = messages.length - 1;
  return messages.map((message, index) => (
    index === last ? { ...message, providerOptions: EPHEMERAL } : message
  ));
}

/**
 * One log line per model request. `input` is everything that was sent, of
 * which `cache_read` was billed at the reduced rate and `cache_write` at the
 * write premium; the rest was billed in full.
 */
export function describeCacheUsage(usage) {
  const details = usage?.inputTokenDetails ?? {};
  return 'token usage:'
    + ` input=${usage?.inputTokens ?? 0}`
    + ` cache_read=${details.cacheReadTokens ?? 0}`
    + ` cache_write=${details.cacheWriteTokens ?? 0}`
    + ` output=${usage?.outputTokens ?? 0}`;
}
