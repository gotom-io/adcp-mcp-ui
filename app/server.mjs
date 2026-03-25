import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stepCountIs, streamText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';
import { createMCPClient } from '@ai-sdk/mcp';
import NodeCache from 'node-cache';
import fs from "fs"

const __dirname = dirname(fileURLToPath(import.meta.url));
const httpClientToolsCache = new NodeCache({ stdTTL: 3600 * 12, checkperiod: 1800, useClones: false });
const contextHistoryCache = new NodeCache({ stdTTL: 3600 * 12, checkperiod: 1800, useClones: false });
const validAdcpAuths = process.env.VALID_ADCP_AUTH_KEYS?.split(',');

if(process.env.MCP_SERVER_CHOICES){
  console.debug("process.env.MCP_SERVER_CHOICES:", process.env.MCP_SERVER_CHOICES);
}
const MAX_CONTEXT_CHARS = 200_000;

const SYSTEM_PROMPT = `You are a helpful AI assistant.

Your goal is to help the user achieve their task as efficiently and accurately as possible which is
1. Call getProducts mcp tool and display the results. Typically in a prompt that looks like a briefing (use it in getProducts brief). Typically first prompt. The brief of this endpoint is meant to be called with all information at once as it calls another LLM to analyze the data.
2. Call getProducts with all information you have to "brief". Don't analyze that data prior, hand over the entire brief to getProducts.
3. The results of getProducts are used in a second step, eventually to call createMediaBuy.
4. The whole point of getting the results from getProducts is that you display them in a way, that createMediaBuy can be executed with it.
5. Only what you display is remembered. So to successfully call createMediaBuy, you need to display all IDs in the text response that is display.
6. Omitting IDs will lead to a fatal error. Always output all IDs in all calls and responses. Example of IDs are product_id, account_id, media_buy_id, format_id, pricing_option_id and more.
7. If getProducts returns values for forecast, make sure to include it as well, be sure to name the forecast values as "available impressions".
8. If account_id is missing, call searchCustomers to figure out the account_id, but ask the user first for permission.

When tools are available use them when the user gives you a call to action. 

## Critical: Avoid Redundant Tool Calls

**Before making any tool call, always check the conversation history for relevant data from previous tool calls.** This includes:
- IDs (accountId, userId, orderId, id, etc.)
- Lists of items already fetched
- Details already retrieved
- Any data that was returned in earlier responses

**Never call a tool to fetch data you already have.** If a previous tool call returned information needed for your current task, use that information directly instead of calling the tool again.

For example:
- If you already fetched a list of Product ID's, don't fetch it again to find a specific product id.
- If you already fetched a customer account id, don't fetch it again to find the customer.
- If you already retrieved account details, reuse those details instead of re-fetching
- If the user references something from a previous response, use the IDs/data from that response

Follow the user's instructions carefully, ask clarifying questions when necessary, and provide clear, concise responses.
`;

// Get context history for a user session
const getContextHistory = (cacheKey) => {
  return contextHistoryCache.get(cacheKey) || [];
};

// Add message to context history and trim if needed
const addToContextHistory = (cacheKey, role, content) => {
  const history = getContextHistory(cacheKey);
  history.push({ role, content });

  // Trim history if total chars exceed limit (simple: just remove oldest messages)
  let totalChars = history.reduce((sum, msg) => sum + msg.content.length, 0);
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

const getHttpClientTools = async function(cacheKey, adcpAuth, mcpServerUrl) {
  let clientTools = httpClientToolsCache.get(cacheKey);
  if (clientTools) {
    return clientTools;
  }

  const httpClient = await createMCPClient({
    transport: {
      type: 'http',
      url: mcpServerUrl,
      headers: {
        'x-adcp-auth': adcpAuth,
        'Authorization': `Basic ${ Buffer.from(`${ process.env.BASIC_AUTH_USER }:${ process.env.BASIC_AUTH_PASS }`).toString('base64') }`
      },
    },
  });
  clientTools = await httpClient.tools();
  httpClientToolsCache.set(cacheKey, clientTools);
  return clientTools;
}

const server = createServer(async (req, res) => {
  if ( req.method === 'GET' && req.url === '/' ) {
    const template = fs.readFileSync("./index.template.html", "utf8")
    let chatConfig =  {};
    if(process.env.MCP_SERVER_CHOICES){
      chatConfig.serverChoices = JSON.parse(process.env.MCP_SERVER_CHOICES || "[]");
    }

    if(! chatConfig.serverChoices){
      chatConfig.serverChoices = [{url: "https://dev-demo-mcp.gotom.io", label: "Dev Demo"}]
    }

    const html = template
        .replaceAll("{{ WINDOW_CHAT_CONFIG }}", JSON.stringify(chatConfig, ' ', 2))

    res.writeHead(200, { "Content-Type": "text/html" })
    res.end(html)
    return;
  }
  if (req.method === 'POST' && req.url === '/api/chat') {
    const adcpAuth = req.headers['x-adcp-auth'];
    if (!adcpAuth || validAdcpAuths.indexOf(adcpAuth) === -1) {
      res.statusCode = 403;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Forbidden: missing/invalid authentication (add the API key to the .env variable VALID_ADCP_AUTH_KEYS)' }));
      return;
    }

    const mcpServerUrl = req.headers['x-mcp-server'];
    if (!mcpServerUrl) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'MCP server missing' }));
      return;
    }

    const aiModel = req.headers['x-ai-model'] || 'anthropic:claude-sonnet-4-6';
    const sessionId = req.headers['x-session-id'];

    if (!sessionId) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Session ID missing' }));
      return;
    }

    const body = await new Promise((resolve) => {
      let data = '';
      req.on('data', chunk => data += chunk);
      req.on('end', () => resolve(JSON.parse(data)));
    });

    console.log({ body })

    // Session key based on auth, MCP server, and unique session ID
    const cacheKey = `${ adcpAuth }:${ mcpServerUrl }:${ sessionId }`;

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
        message: `Context window limit reached. ${ messagesRemoved } older message${ messagesRemoved > 1 ? 's were' : ' was' } removed from context. `
      }) + '\n');
    }

    const result = await streamText({
      model: getModel(aiModel),
      system: SYSTEM_PROMPT,
      messages: messages,
      temperature: 0,
      tools: await getHttpClientTools(cacheKey, adcpAuth, mcpServerUrl),
      onError: ({ error }) => {
        console.log({ onError: error })
        res.write(JSON.stringify({
          type: 'error',
          error: (error?.message || String(error)) + ' ',
        }) + '\n');
      },
      onFinish: (onFinish) => {
        console.log({ onFinish })
        if (onFinish.text) {
          addToContextHistory(cacheKey, 'assistant', onFinish.text);
        }
      },
      onStepFinish: (stepResult) => {
        console.log({ onStepFinish: stepResult })
      },
      onAbort: (onAbort) => {
        console.log({ onAbort })
      },
      maxSteps: 10,
      stopWhen: stepCountIs(10),
    });

    for await (const part of result.fullStream) {
      res.write(JSON.stringify(part) + ' \n');
    }
    res.end()

    return;
  }

  // Serve static files
  const staticFiles = {
    '/styles.css': { file: 'styles.css', contentType: 'text/css' },
    '/app.js': { file: 'app.js', contentType: 'application/javascript' },
  };

  const staticFile = staticFiles[req.url];

  if(staticFile){
    try {
      const content = await readFile(join(__dirname, staticFile.file));
      res.setHeader('Content-Type', staticFile.contentType);
      res.end(content);
    } catch (err) {
      res.statusCode = 500;
      res.end(`Error loading ${staticFile.file}`);
    }
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${ PORT }`);
});
