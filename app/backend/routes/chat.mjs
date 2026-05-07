import { getHeaderInfo, getBody, getModel } from '../utils.mjs';
import { getHttpClientTools, addToContextHistory, clearContextHistory, cacheKeySeparator, MAX_CONTEXT_CHARS } from '../cache.mjs';
import { createLogger, NO_ID_FOUND } from '../logger.mjs';
import { streamText, stepCountIs } from 'ai';
import SYSTEM_PROMPT from '../system-prompt.mjs';
import { getMcpSessionIdShort } from '../../shared.mjs';

const handleChat = async (req, res) => {
  const headerInfo = getHeaderInfo(req, res);
  if (res === headerInfo) {
    return; // some error
  }

  const { adcpAuth, mcpServerUrl, aiModel, sessionId } = headerInfo;
  const logger = createLogger(sessionId);

  const body = await getBody(req);

  logger.debug({ body });

  // Session key based on auth, MCP server, and unique session ID
  const cacheKey = `${adcpAuth}${cacheKeySeparator}${mcpServerUrl}${cacheKeySeparator}${sessionId}`;

  // we generously always write the cache key to context history even though it doesnt change.
  // This simplifies caching and clearing of context history
  addToContextHistory(cacheKey, 'assistant', 'xMcpSessionId: ' + getMcpSessionIdShort(sessionId));

  // Handle clear history command
  if (body.clearHistory) {
    clearContextHistory(cacheKey);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: true, message: 'History cleared' }));
    return;
  }

  // Add user message to history and get full context
  const { history: messages, messagesRemoved } = addToContextHistory(cacheKey, 'user', body.prompt);

  // If messages were truncated, send a warning to the client first
  if (messagesRemoved > 0) {
    res.write(JSON.stringify({
      type: 'context-truncated',
      messagesRemoved,
      message: `Context window limit reached. ${messagesRemoved} older message${messagesRemoved > 1 ? 's were' : ' was'} removed from context. `
    }) + '\n');
  }

  let tools;
  try {
    tools = await getHttpClientTools(cacheKey, adcpAuth, mcpServerUrl, createLogger);
  } catch (err) {
    logger.error('Failed to connect to MCP server:', err);
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json');
    const errorMessage = err.cause?.code === 'ENOTFOUND'
      ? `Cannot reach MCP server: ${err.cause.hostname} not found`
      : `Failed to connect to MCP server: ${err.message || String(err)}`;
    res.end(JSON.stringify({ error: errorMessage }));
    return;
  }

  try {
    const result = await streamText({
      model: getModel(aiModel),
      system: SYSTEM_PROMPT,
      messages: messages,
      temperature: 0,
      tools,
      onError: ({ error }) => {
        logger.debug({ onError: error });
        res.write(JSON.stringify({
          type: 'error',
          error: (error?.message || String(error)) + ' ',
        }) + '\n');
      },
      onFinish: (onFinish) => {
        logger.debug({ onFinish });
        if (onFinish.text) {
          addToContextHistory(cacheKey, 'assistant', onFinish.text);
        }
      },
      onStepFinish: (stepResult) => {
        const xMcpRequestId = stepResult?.toolResults[0]?.output?._meta['x-mcp-request-id'];
        if (xMcpRequestId) {
          logger.setMcpRequestId(xMcpRequestId); // notice that this is actually a bit too late, some logs are missed. But it's currently a compromise
          logger.log("x-mcp-request-id: " + xMcpRequestId);
          addToContextHistory(cacheKey, 'assistant', "Current xMcpRequestId: " + xMcpRequestId);
        } else {
          logger.log("x-mcp-request-id: unknown");
        }
        logger.debug({ onStepFinish: stepResult });
      },
      onAbort: (onAbort) => {
        logger.debug({ onAbort });
      },
      maxSteps: 10,
      stopWhen: stepCountIs(10),
    });

    for await (const part of result.fullStream) {
      res.write(JSON.stringify(part) + ' \n');
    }
    res.end();
  } catch (err) {
    logger.error('Error during streaming:', err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: `Server error: ${err.message || String(err)}` }));
    } else {
      res.write(JSON.stringify({ type: 'error', error: err.message || String(err) }) + '\n');
      res.end();
    }
  }
};

export { handleChat };
