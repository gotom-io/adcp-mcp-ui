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
import path from 'node:path';
import * as util from "node:util";

const __dirname = dirname(fileURLToPath(import.meta.url));
const httpClientToolsCache = new NodeCache({ stdTTL: 3600 * 12, checkperiod: 1800, useClones: false });
const loggerCache = new NodeCache({ stdTTL: 3600 * 12, checkperiod: 1800, useClones: false });
const contextHistoryCache = new NodeCache({ stdTTL: 3600 * 12, checkperiod: 1800, useClones: false });
const cacheKeySeparator = '___';
const validAdcpAuths = process.env.VALID_ADCP_AUTH_KEYS?.split(',');
const LOG_FILE = process.env.LOG_FILE || '/app/adcp-mcp-ui-logs/server.log';
fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
const NO_ID_FOUND = '-';

const getLogger = (sessionId = NO_ID_FOUND) => {
  if(loggerCache.has(sessionId)){
    return loggerCache.get(sessionId);
  }

  const logger = {
    requestId: NO_ID_FOUND,
    sessionId,

    setMcpRequestId(id) {
      this.requestId = id;
    },

    error: (...args) => write('ERROR', ...args),
    warn: (...args) => write('WARN', ...args),
    info: (...args) => write('INFO', ...args),
    log: (...args) => write('LOG', ...args),
    debug: (...args) => write('DEBUG', ...args),
  };

  const write = (level, ...args) => {
    const messageStdout = args.map(arg =>
        typeof arg === 'object' ? util.inspect(arg, { depth: 5, colors: false, compact: false }) : String(arg)
    ).join(' ');
    const messageLog = args.map(arg =>
        typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
    ).join(' ');

    const shortSessionId = logger.sessionId !== NO_ID_FOUND ? getMcpSessionIdShort(logger.sessionId) : NO_ID_FOUND;
    const lineStd =
        `[${new Date().toISOString()}] ` +
        `[${level}] ` +
        `[sessionId:${shortSessionId}] ` +
        `[requestId:${logger.requestId}] ` +
        `${messageStdout}\n`;
    const lineLog =
        `[${new Date().toISOString()}] ` +
        `[${level}] ` +
        `[sessionId:${shortSessionId}] ` +
        `[requestId:${logger.requestId}] ` +
        `${messageLog}\n`;

    if (level === 'ERROR') {
      process.stderr.write(lineStd);
    } else {
      process.stdout.write(lineStd);
    }

    logStream.write(lineLog);
  };

  loggerCache.set(sessionId, logger);
  return logger;
};


if(process.env.MCP_SERVER_CHOICES){
  getLogger().debug("process.env.MCP_SERVER_CHOICES:", process.env.MCP_SERVER_CHOICES);
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

// Get context history for a user session
const getContextHistory = (cacheKey) => {
  return contextHistoryCache.get(cacheKey) || [];
};

// Add message to context history and trim if needed
const addToContextHistory = (cacheKey, role, content) => {
  const history = getContextHistory(cacheKey);
  history.push({ role, content });

  function countHistorySize() {
    return history.reduce((sum, msg) => sum + msg.content.length, 0);
  }

// Trim history if total chars exceed limit (simple: just remove oldest messages)
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

// Helper to parse cookies from request
const parseCookies = (req) => {
  const cookieHeader = req.headers.cookie || '';
  const cookies = {};
  cookieHeader.split(';').forEach(cookie => {
    const [name, ...rest] = cookie.trim().split('=');
    if (name) {
      cookies[name] = decodeURIComponent(rest.join('='));
    }
  });
  return cookies;
};

// Helper to create HttpOnly cookie string
const isLocal = process.env.GOTOM_ENV === 'local';
const createSecureCookie = (name, value, maxAge = 31536000) => {
  const secureFlag = isLocal ? '' : '; Secure';
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly${secureFlag}; SameSite=Strict`;
};

function getMcpSessionIdShort(sessionId) {
  return 'sid_' + sessionId.slice(0, 8);
}


function getHeaderInfo(req, res) {
  const adcpAuth = req.headers['x-adcp-auth'];
  if ( !adcpAuth || validAdcpAuths.indexOf(adcpAuth) === -1 ) {
    res.statusCode = 403;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Forbidden: missing/invalid authentication (add the API key to the .env variable VALID_ADCP_AUTH_KEYS)' }));
    return res;
  }

  const mcpServerUrl = req.headers['x-mcp-server'];
  if ( !mcpServerUrl ) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'MCP server missing' }));
    return res;
  }

  const aiModel = req.headers['x-ai-model'] || 'anthropic:claude-sonnet-4-6';
  const sessionId = req.headers['x-session-id'];

  if ( !sessionId ) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Session ID missing' }));
    return res;
  }
  return { adcpAuth, mcpServerUrl, aiModel, sessionId };
}

async function getBody(req) {
  return await new Promise((resolve) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => resolve(JSON.parse(data)));
  });
}

const server = createServer(async (req, res) => {

  let logger = getLogger();
  logger.setMcpRequestId(NO_ID_FOUND);
  // GET /api/settings - Read settings from HttpOnly cookies
  if (req.method === 'GET' && req.url === '/api/settings') {
    const cookies = parseCookies(req);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      adcp_auth: cookies.adcp_auth || '',
      mcp_server: cookies.mcp_server || '',
      ai_model: cookies.ai_model || '',
    }));
    return;
  }

  // POST /api/settings - Save settings as HttpOnly cookies
  if (req.method === 'POST' && req.url === '/api/settings') {
    const body = await getBody(req);

    const cookiesToSet = [];
    if (body.adcp_auth !== undefined) {
      cookiesToSet.push(createSecureCookie('adcp_auth', body.adcp_auth));
    }
    if (body.mcp_server !== undefined) {
      cookiesToSet.push(createSecureCookie('mcp_server', body.mcp_server));
    }
    if (body.ai_model !== undefined) {
      cookiesToSet.push(createSecureCookie('ai_model', body.ai_model));
    }

    res.setHeader('Set-Cookie', cookiesToSet);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: true }));
    return;
  }

  if ( req.method === 'GET' && req.url === '/' ) {
    const template = fs.readFileSync("./index.template.html", "utf8")
    let chatConfig =  {};
    if(process.env.MCP_SERVER_CHOICES){
      chatConfig.serverChoices = JSON.parse(process.env.MCP_SERVER_CHOICES || "[]");
    }

    if(! chatConfig.serverChoices){
      chatConfig.serverChoices = [{url: "https://dev-demo-mcp.gotom.io", label: "Dev Demo"},{url: "https://dev-goldbach-mcp.gotom.io", label: "Dev Goldbach"}]
    }

    const html = template
        .replaceAll("{{ WINDOW_CHAT_CONFIG }}", JSON.stringify(chatConfig, ' ', 2))

    res.writeHead(200, { "Content-Type": "text/html" })
    res.end(html)
    return;
  }

  if (req.method === 'GET' && req.url === '/api/logs') {
    const headerInfo = getHeaderInfo(req, res);

    if (res === headerInfo) {
      return; // error already sent
    }

    const { adcpAuth, mcpServerUrl, sessionId } = headerInfo;

    let logger = getLogger(sessionId);

    const cacheKey =
        `${adcpAuth}${cacheKeySeparator}${mcpServerUrl}${cacheKeySeparator}${sessionId}`;

    try {
      const tools = await getHttpClientTools(
          cacheKey,
          adcpAuth,
          mcpServerUrl
      );

      const getLogsTool = tools.getLogs;

      if (!getLogsTool) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          error: 'getLogs tool not found'
        }));
        return;
      }

      logger.debug('Calling getLogs MCP tool');

      const result = await getLogsTool.execute({});

      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(result));

    } catch (err) {
      logger.error('Error fetching logs:', err);

      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        error: err.message || String(err)
      }));
    }

    return;
  }
  if (req.method === 'POST' && req.url === '/api/chat') {
    const headerInfo = getHeaderInfo(req, res);
    if(res === headerInfo){
      return res; // some error
    }
    const { adcpAuth, mcpServerUrl, aiModel, sessionId } = headerInfo;
    logger = getLogger(sessionId)

    const body = await getBody(req);

    logger.debug({ body })

    // Session key based on auth, MCP server, and unique session ID
    const cacheKey = `${ adcpAuth }${cacheKeySeparator}${ mcpServerUrl }${cacheKeySeparator}${ sessionId }`;

    // we generously always write the cacke key to context history even though it doesnt change.
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
          logger.debug({ onError: error })
          res.write(JSON.stringify({
            type: 'error',
            error: (error?.message || String(error)) + ' ',
          }) + '\n');
        },
        onFinish: (onFinish) => {
          logger.debug({ onFinish })
          if (onFinish.text) {
            addToContextHistory(cacheKey, 'assistant', onFinish.text);
          }
        },
        onStepFinish: (stepResult) => {

          const xMcpRequestId = stepResult?.toolResults[0]?.output?._meta['x-mcp-request-id'];
          if(xMcpRequestId){
            logger.setMcpRequestId(xMcpRequestId); //  notice that this is actually a bit too late, some logs are missed. But it's currently a compromise
            logger.log("x-mcp-request-id: " + xMcpRequestId);
            addToContextHistory(cacheKey, 'assistant', "Current xMcpRequestId: " + xMcpRequestId);
          }else{
            logger.log("x-mcp-request-id: unknown");
          }
          logger.debug({ onStepFinish: stepResult })
        },
        onAbort: (onAbort) => {
          logger.debug({ onAbort })
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

    return;
  }

  // Serve static files
  const staticFiles = {
    '/styles.css': { file: 'styles.css', contentType: 'text/css' },
    '/app.js': { file: 'app.js', contentType: 'application/javascript' },
    '/shared.mjs': { file: 'shared.mjs', contentType: 'application/javascript' },
  };

  // Strip query string for static file matching
  const urlPath = req.url.split('?')[0];
  const staticFile = staticFiles[urlPath];

  if(staticFile){
    try {
      const content = await readFile(join(__dirname, staticFile.file));
      res.setHeader('Content-Type', staticFile.contentType);
      res.end(content);
    } catch (err) {
      res.statusCode = 500;
      res.end(`Error loading ${staticFile.file}`);
    }
  } else {
    res.statusCode = 404;
    res.end('Not Found');
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  getLogger().log(`Server running at http://localhost:${ PORT }`);
});
