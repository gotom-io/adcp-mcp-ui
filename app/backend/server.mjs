import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stepCountIs, streamText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';
import { createMCPClient } from '@ai-sdk/mcp';
import NodeCache from 'node-cache';
import fs from 'fs';
import path from 'node:path';
import * as util from 'node:util';
import { getMcpSessionIdShort } from '../shared/shared.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Constants ---
const MAX_CONTEXT_CHARS = 200_000;
const LOG_FILE = process.env.LOG_FILE || '/app/adcp-mcp-ui-logs/server.log';
fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });

// --- Caches ---
const toolsCache    = new NodeCache({ stdTTL: 3600 * 12, checkperiod: 1800, useClones: false });
const historyCache  = new NodeCache({ stdTTL: 3600 * 12, checkperiod: 1800, useClones: false });

// --- Helpers ---

function log(level, ...args) {
  const msg = args.map(a => typeof a === 'object' ? util.inspect(a, { depth: 5, colors: false, compact: false }) : String(a)).join(' ');
  const line = `[${new Date().toISOString()}] [${level}] ${msg}\n`;
  if (level === 'ERROR') process.stderr.write(line);
  else process.stdout.write(line);
  logStream.write(line);
}

const parseCookies = (req) => {
  const cookies = {};
  req.headers.cookie?.split(';').forEach(c => {
    const [k, ...v] = c.trim().split('=');
    if (k) cookies[k] = decodeURIComponent(v.join('='));
  });
  return cookies;
};

const createSecureCookie = (name, value, maxAge = 31536000) => {
  const secure = process.env.GOTOM_ENV !== 'local' ? '; Secure' : '';
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly${secure}; SameSite=Strict`;
};

const getBody = (req) => new Promise((resolve) => {
  let data = '';
  req.on('data', c => (data += c));
  req.on('end', () => resolve(JSON.parse(data)));
});

const getModel = (model) => {
  const [provider, name] = model.split(':');
  if (provider === 'openai') return openai(name);
  return anthropic(name || 'claude-sonnet-4-6');
};

const getMcpTools = async (cacheKey, adcpAuth, mcpUrl) => {
  if (toolsCache.has(cacheKey)) return toolsCache.get(cacheKey);

  const sessionId = cacheKey.split('___')[2];
  const client = await createMCPClient({
    transport: {
      type: 'http',
      url: mcpUrl,
      headers: {
        'x-adcp-auth': adcpAuth,
        'x-mcp-session-id': getMcpSessionIdShort(sessionId),
        'Authorization': `Basic ${Buffer.from(`${process.env.BASIC_AUTH_USER}:${process.env.BASIC_AUTH_PASS}`).toString('base64')}`,
      },
    },
  });

  const tools = await client.tools();
  toolsCache.set(cacheKey, tools);
  return tools;
};

const getHistory = (key) => historyCache.get(key) || [];

const addHistory = (key, role, content) => {
  const history = getHistory(key);
  history.push({ role, content });

  let total = history.reduce((s, m) => s + m.content.length, 0);
  let removed = 0;
  while (total > MAX_CONTEXT_CHARS && history.length > 1) {
    total -= history.shift().content.length;
    removed++;
  }

  historyCache.set(key, history);
  return { history, removed };
};

// --- System prompt ---
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

// --- Auth check (returns early on failure) ---
function authCheck(req, res) {
  const validKeys = process.env.VALID_ADCP_AUTH_KEYS?.split(',');
  const adcpAuth = req.headers['x-adcp-auth'];
  if (!adcpAuth || !validKeys?.includes(adcpAuth)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Forbidden: missing/invalid authentication (add the API key to the .env variable VALID_ADCP_AUTH_KEYS)' }));
  }

  const mcpServerUrl = req.headers['x-mcp-server'];
  if (!mcpServerUrl) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'MCP server missing' }));
  }

  const sessionId = req.headers['x-session-id'];
  if (!sessionId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Session ID missing' }));
  }

  return { adcpAuth, mcpServerUrl, aiModel: req.headers['x-ai-model'] || 'anthropic:claude-sonnet-4-6', sessionId };
}

// --- Server ---
const server = createServer(async (req, res) => {
  const { method, url } = req;
  const parsed = new URL(url, `http://${req.headers.host}`);
  const path = parsed.pathname.split('?')[0];

  // GET /api/settings
  if (method === 'GET' && path === '/api/settings') {
    const cookies = parseCookies(req);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      adcp_auth: cookies.adcp_auth || '',
      mcp_server: cookies.mcp_server || '',
      ai_model: cookies.ai_model || '',
    }));
  }

  // POST /api/settings
  if (method === 'POST' && path === '/api/settings') {
    const body = await getBody(req);
    const cookies = [];
    if (body.adcp_auth !== undefined) cookies.push(createSecureCookie('adcp_auth', body.adcp_auth));
    if (body.mcp_server !== undefined) cookies.push(createSecureCookie('mcp_server', body.mcp_server));
    if (body.ai_model !== undefined)   cookies.push(createSecureCookie('ai_model', body.ai_model));
    res.setHeader('Set-Cookie', cookies);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true }));
  }

  // GET / — serve HTML
  if (method === 'GET' && path === '/') {
    const template = fs.readFileSync(join(__dirname, '../frontend/index.template.html'), 'utf8');
    let chatConfig = {};
    if (process.env.MCP_SERVER_CHOICES) {
      chatConfig.serverChoices = JSON.parse(process.env.MCP_SERVER_CHOICES);
    }
    if (!chatConfig.serverChoices) {
      chatConfig.serverChoices = [
        { url: 'https://dev-demo-mcp.gotom.io', label: 'Dev Demo' },
        { url: 'https://dev-goldbach-mcp.gotom.io', label: 'Dev Goldbach' },
      ];
    }
    const html = template.replaceAll('{{ WINDOW_CHAT_CONFIG }}', JSON.stringify(chatConfig, null, 2));
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(html);
  }

  // GET /api/logs
  if (method === 'GET' && path === '/api/logs') {
    const info = authCheck(req, res);
    if (res === info) return;
    const { adcpAuth, mcpServerUrl, sessionId } = info;
    const query = parsed.searchParams.get('query') || '';
    const cacheKey = `${adcpAuth}___${mcpServerUrl}___${sessionId}`;

    try {
      const tools = await getMcpTools(cacheKey, adcpAuth, mcpServerUrl);
      const getLogsTool = tools.getLogs;
      if (!getLogsTool) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'getLogs tool not found' }));
      }
      const result = await getLogsTool.execute({ searchString: query, maxLinesReturned: 2000 });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(result));
    } catch (err) {
      log('ERROR', 'Error fetching logs:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message || String(err) }));
    }
  }

  // POST /api/chat
  if (method === 'POST' && path === '/api/chat') {
    const info = authCheck(req, res);
    if (res === info) return;
    const { adcpAuth, mcpServerUrl, aiModel, sessionId } = info;
    const body = await getBody(req);
    const cacheKey = `${adcpAuth}___${mcpServerUrl}___${sessionId}`;

    // Clear history
    if (body.clearHistory) {
      historyCache.del(cacheKey);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, message: 'History cleared' }));
    }

    // Add user message
    const { history: messages, removed } = addHistory(cacheKey, 'user', body.prompt);
    if (removed > 0) {
      res.write(JSON.stringify({
        type: 'context-truncated',
        messagesRemoved: removed,
        message: `Context window limit reached. ${removed} older message${removed > 1 ? 's were' : ' was'} removed from context. `,
      }) + '\n');
    }

    // Fetch MCP tools
    let tools;
    try {
      tools = await getMcpTools(cacheKey, adcpAuth, mcpServerUrl);
    } catch (err) {
      log('ERROR', 'Failed to connect to MCP server:', err);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        error: err.cause?.code === 'ENOTFOUND'
          ? `Cannot reach MCP server: ${err.cause.hostname} not found`
          : `Failed to connect to MCP server: ${err.message || String(err)}`,
      }));
    }

    try {
      const result = await streamText({
        model: getModel(aiModel),
        system: SYSTEM_PROMPT,
        messages,
        temperature: 0,
        tools,
        onError: ({ error }) => {
          log('DEBUG', 'onError:', error);
          res.write(JSON.stringify({ type: 'error', error: (error?.message || String(error)) + ' ' }) + '\n');
        },
        onFinish: ({ text }) => {
          if (text) addHistory(cacheKey, 'assistant', text);
        },
        onStepFinish: (stepResult) => {
          const xMcpRequestId = stepResult?.toolResults[0]?.output?._meta['x-mcp-request-id'];
          log(xMcpRequestId ? 'LOG' : 'WARN', 'x-mcp-request-id:', xMcpRequestId || 'unknown');
        },
        onAbort: (o) => log('DEBUG', 'onAbort:', o),
        maxSteps: 10,
        stopWhen: stepCountIs(10),
      });

      for await (const part of result.fullStream) {
        res.write(JSON.stringify(part) + ' \n');
      }
      res.end();
    } catch (err) {
      log('ERROR', 'Error during streaming:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: `Server error: ${err.message || String(err)}` }));
      }
      res.write(JSON.stringify({ type: 'error', error: err.message || String(err) }) + '\n');
      res.end();
    }
    return;
  }

  // Static files
  const staticFiles = {
    '/frontend/styles.css': { file: '../frontend/styles.css',  type: 'text/css' },
    '/frontend/app.js':     { file: '../frontend/app.js',      type: 'application/javascript' },
    '/shared/shared.mjs':   { file: '../shared/shared.mjs',    type: 'application/javascript' },
  };

  const staticFile = staticFiles[path];
  if (staticFile) {
    try {
      const content = await readFile(join(__dirname, staticFile.file));
      res.writeHead(200, { 'Content-Type': staticFile.type });
      return res.end(content);
    } catch (err) {
      log('ERROR', `Error loading ${staticFile.file}:`, err);
      res.writeHead(500);
      return res.end(`Error loading ${staticFile.file}`);
    }
  }

  res.writeHead(404);
  res.end('Not Found');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => log('LOG', `Server running at http://localhost:${PORT}`));
