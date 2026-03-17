import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stepCountIs, streamText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';
import { createMCPClient } from '@ai-sdk/mcp';
import NodeCache from 'node-cache';

const __dirname = dirname(fileURLToPath(import.meta.url));
const httpClientToolsCache = new NodeCache({ stdTTL: 3600 * 12, checkperiod: 1800, useClones: false });
const contextHistoryCache = new NodeCache({ stdTTL: 3600 * 12, checkperiod: 1800, useClones: false });
const validAdcpAuths = process.env.VALID_ADCP_AUTH_KEYS?.split(',');

const MAX_CONTEXT_CHARS = 200_000;

const SYSTEM_PROMPT = `You are a helpful AI assistant.

Your goal is to help the user achieve their task as efficiently and accurately as possible.

When tools are available, prefer using them whenever they can improve the quality, accuracy, or efficiency of the response. 
Only answer directly without tools if a tool would not meaningfully help.

Follow the user's instructions carefully, ask clarifying questions when necessary, and provide clear, concise responses.

When displaying results to the user, always include relevant identifiers (such as accountId, id, userId, etc.) so the user can reference and identify specific items.`;

// Get context history for a user session
const getContextHistory = (sessionKey) => {
  return contextHistoryCache.get(sessionKey) || [];
};

// Add message to context history and trim if needed
const addToContextHistory = (sessionKey, role, content) => {
  const history = getContextHistory(sessionKey);
  history.push({ role, content });

  // Trim history if total chars exceed limit (simple: just remove oldest messages)
  let totalChars = history.reduce((sum, msg) => sum + msg.content.length, 0);
  let messagesRemoved = 0;

  while (totalChars > MAX_CONTEXT_CHARS && history.length > 1) {
    const removed = history.shift();
    totalChars -= removed.content.length;
    messagesRemoved++;
  }

  contextHistoryCache.set(sessionKey, history);
  return { history, messagesRemoved };
};

// Clear context history for a session
const clearContextHistory = (sessionKey) => {
  contextHistoryCache.del(sessionKey);
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

const getHttpClientTools = async function(adcpAuth, mcpServerUrl) {
  const cacheKey = `${ adcpAuth }:${ mcpServerUrl }`;
  let clientTools = httpClientToolsCache.get(cacheKey);
  if (!clientTools) {
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
  }
  httpClientToolsCache.set(cacheKey, clientTools);
  return clientTools;
}

const server = createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/api/chat') {
    const adcpAuth = req.headers['x-adcp-auth'];
    if (!adcpAuth || validAdcpAuths.indexOf(adcpAuth) === -1) {
      res.statusCode = 403;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Forbidden: missing/invalid authentication' }));
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
    const sessionKey = `${ adcpAuth }:${ mcpServerUrl }:${ sessionId }`;

    // Handle clear history command
    if (body.clearHistory) {
      clearContextHistory(sessionKey);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: true, message: 'History cleared' }));
      return;
    }

    // Add user message to history and get full context
    const { history: messages, messagesRemoved } = addToContextHistory(sessionKey, 'user', body.prompt);

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
      tools: await getHttpClientTools(adcpAuth, mcpServerUrl),
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
          addToContextHistory(sessionKey, 'assistant', onFinish.text);
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
    '/': { file: 'index.html', contentType: 'text/html' },
    '/styles.css': { file: 'styles.css', contentType: 'text/css' },
    '/app.js': { file: 'app.js', contentType: 'application/javascript' },
  };

  const staticFile = staticFiles[req.url] || staticFiles['/'];

  try {
    const content = await readFile(join(__dirname, staticFile.file));
    res.setHeader('Content-Type', staticFile.contentType);
    res.end(content);
  } catch (err) {
    res.statusCode = 500;
    res.end(`Error loading ${ staticFile.file }`);
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${ PORT }`);
});
