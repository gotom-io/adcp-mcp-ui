// POST /api/chat - Stream chat completions with MCP tool support.

import { stepCountIs, streamText } from 'ai';
import { getLogger } from '../logger.mjs';
import { getHeaderInfo, readJsonBody, sendError, sendJson } from '../http-utils.mjs';
import { getHttpClientTools, buildCacheKey } from '../mcp-client.mjs';
import {
  addToContextHistory,
  clearContextHistory,
} from '../context-history.mjs';
import { getModel } from '../ai-models.mjs';
import { SYSTEM_PROMPT } from '../system-prompt.mjs';
import { getMcpSessionIdShort } from '../../shared/session.mjs';

const MAX_STEPS = 10;

const writeNdjson = (res, payload) => {
  res.write(JSON.stringify(payload) + '\n');
};

const sendMcpConnectionError = (res, err) => {
  const message = err.cause?.code === 'ENOTFOUND'
    ? `Cannot reach MCP server: ${err.cause.hostname} not found`
    : `Failed to connect to MCP server: ${err.message || String(err)}`;
  sendError(res, 502, message);
};

export const handlePostChat = async (req, res) => {
  const headerCheck = getHeaderInfo(req, res);
  if (!headerCheck.ok) return;

  const { adcpAuth, mcpServerUrl, aiModel, sessionId } = headerCheck.info;
  const logger = getLogger(sessionId);
  const cacheKey = buildCacheKey(adcpAuth, mcpServerUrl, sessionId);

  const body = await readJsonBody(req);
  logger.debug({ body });

  // Always record session ID in history (cheap, simplifies clearing).
  addToContextHistory(cacheKey, 'assistant', 'xMcpSessionId: ' + getMcpSessionIdShort(sessionId));

  if (body.clearHistory) {
    clearContextHistory(cacheKey);
    return sendJson(res, 200, { success: true, message: 'History cleared' });
  }

  const { history: messages, messagesRemoved } = addToContextHistory(cacheKey, 'user', body.prompt);

  if (messagesRemoved > 0) {
    writeNdjson(res, {
      type: 'context-truncated',
      messagesRemoved,
      message: `Context window limit reached. ${messagesRemoved} older message${messagesRemoved > 1 ? 's were' : ' was'} removed from context. `,
    });
  }

  let tools;
  try {
    tools = await getHttpClientTools(cacheKey, adcpAuth, mcpServerUrl);
  } catch (err) {
    logger.error('Failed to connect to MCP server:', err);
    return sendMcpConnectionError(res, err);
  }

  try {
    const result = await streamText({
      model: getModel(aiModel),
      system: SYSTEM_PROMPT,
      messages,
      temperature: 0,
      tools,
      onError: ({ error }) => {
        logger.debug({ onError: error });
        writeNdjson(res, { type: 'error', error: (error?.message || String(error)) + ' ' });
      },
      onFinish: (onFinish) => {
        logger.debug({ onFinish });
        if (onFinish.text) {
          addToContextHistory(cacheKey, 'assistant', onFinish.text);
        }
      },
      onStepFinish: (stepResult) => {
        const xMcpRequestId = stepResult?.toolResults?.[0]?.output?._meta?.['x-mcp-request-id'];
        if (xMcpRequestId) {
          // Notice: this is set after the step completes, so some logs are missed. Compromise.
          logger.setMcpRequestId(xMcpRequestId);
          logger.log('x-mcp-request-id: ' + xMcpRequestId);
          addToContextHistory(cacheKey, 'assistant', 'Current xMcpRequestId: ' + xMcpRequestId);
        } else {
          logger.log('x-mcp-request-id: unknown');
        }
        logger.debug({ onStepFinish: stepResult });
      },
      onAbort: (onAbort) => logger.debug({ onAbort }),
      maxSteps: MAX_STEPS,
      stopWhen: stepCountIs(MAX_STEPS),
    });

    for await (const part of result.fullStream) {
      res.write(JSON.stringify(part) + ' \n');
    }
    res.end();
  } catch (err) {
    logger.error('Error during streaming:', err);
    if (!res.headersSent) {
      sendError(res, 500, `Server error: ${err.message || String(err)}`);
    } else {
      writeNdjson(res, { type: 'error', error: err.message || String(err) });
      res.end();
    }
  }
};
