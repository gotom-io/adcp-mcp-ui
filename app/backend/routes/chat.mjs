import { getLogger } from '../services/logger.mjs';
import { getContextHistory, addToContextHistory, clearContextHistory } from '../services/context.mjs';
import { getHttpClientTools } from '../services/mcp-client.mjs';
import { getMcpSessionIdShort } from "../../shared/shared.mjs";
import { stepCountIs, streamText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';
import { getHeaderInfo } from './settings.mjs';

const cacheKeySeparator = '___';

const SYSTEM_PROMPT = `You are a helpful AI assistant.

Your goal is to help the user achieve their task as efficiently and accurately as possible which is
1. Call getProducts mcp tool and display the results. Typically in a prompt that looks like a briefing (use it in getProducts brief). Typically first prompt. The brief of this endpoint is meant to be called with all information at once as it calls another LLM to analyze the data.
2. Call getProducts with all information you have to "brief". Don't analyze that data prior, hand over the entire brief to getProducts.
3. The results of getProducts are used in a second step, eventually to call createMediaBuy.
4. The whole point of getting the results from getProducts is that you display them in a way, that createMediaBuy can be executed with it.
5. Only what you display is remembered. So to successfully call createMediaBuy, you need to display all IDs in the text response that is display.
6. Omitting IDs will lead to a fatal error. Always output all IDs in all calls and responses. Example of IDs are product_id, account_id, media_buy_id, format_id, pricing_option_id and more.
7. If getProducts returns values for forecast, make sure to include it as well, be sure to name the forecast values as "available impressions". Don't mention the budget with the forecast, only the impressions.
8. In the format_id only display the id part, leave out agent_url, width and height.
9. Display results after displaying it in paragraphs as well in tables.
10. Don't mix results in the table inside the same column. Don't do: Audience/Channel inside the same column. Or Audience/Publisher. Make separate columns.

When tools are available use them when the user gives you a call to action. 

## Critical: Avoid Redundant Tool Calls

**Before making any tool call, always check the conversation history for relevant data from previous tool calls.** This includes:
- IDs (accountId, userId, orderId, id, etc.)
- Lists of items already fetched
- Details already retrieved
- Any data that was returned in earlier responses

**Never call a tool to fetch data you already have.** If a previous tool call returned information needed for your current task, use that information directly instead of calling the tool again.

For example:
- If you already fetched a list of Product IDs, don't fetch it again to find a specific product id.
- If you already fetched a customer account id, don't fetch it again to find the customer.
- If you already retrieved account details, reuse those details instead of re-fetching
- If the user references something from a previous response, use the IDs/data from that response

Follow the user's instructions carefully, ask clarifying questions when necessary, and provide clear, concise responses.
`;

const getModel = (modelString) => {
  const [provider, modelName] = modelString.split(':');
  switch (provider) {
    case 'anthropic':
      return anthropic(modelName);
    case 'openai':
      return openai(modelName);
    default:
      return anthropic('claude-sonnet-4-6');
  }
};

export const handleChat = async (req, res) => {
  const headerInfo = getHeaderInfo(req, res);
  if(res === headerInfo){
    return res; // some error
  }
  const { adcpAuth, mcpServerUrl, aiModel, sessionId } = headerInfo;
  const logger = getLogger(sessionId);

  const body = await new Promise((resolve) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => resolve(JSON.parse(data)));
  });

  logger.debug({ body });

  const cacheKey = `${ adcpAuth }${cacheKeySeparator}${ mcpServerUrl }${cacheKeySeparator}${ sessionId }`;

  addToContextHistory(cacheKey, 'assistant', 'xMcpSessionId: ' + getMcpSessionIdShort(sessionId));

  if (body.clearHistory) {
    clearContextHistory(cacheKey);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: true, message: 'History cleared' }));
    return;
  }

  const { history: messages, messagesRemoved } = addToContextHistory(cacheKey, 'user', body.prompt);

  if (messagesRemoved > 0) {
    res.write(JSON.stringify({
      type: 'context-truncated',
      messagesRemoved,
      message: `Context window limit reached. ${ messagesRemoved } older message${ messagesRemoved > 1 ? 's were' : ' was' } removed from context. `
    }) + '\n');
  }

  let tools;
  try {
    tools = await getHttpClientTools(cacheKey, adcpAuth, mcpServerUrl);
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
        if(xMcpRequestId){
          logger.setMcpRequestId(xMcpRequestId);
          logger.log("x-mcp-request-id: " + xMcpRequestId);
          addToContextHistory(cacheKey, 'assistant', "Current xMcpRequestId: " + xMcpRequestId);
        }else{
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
