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
const httpClientToolsCache = new NodeCache({ stdTTL: 3600, checkperiod: 1800, useClones: false });
const contextHistoryCache = new NodeCache({ stdTTL: 3600, checkperiod: 1800, useClones: false });
const validAdcpAuths = process.env.VALID_ADCP_AUTH_KEYS?.split(',');

const MAX_CONTEXT_CHARS = 20000;

// Get context history for a user session
const getContextHistory = (sessionKey) => {
  return contextHistoryCache.get(sessionKey) || [];
};

// Add message to context history and trim if needed
const addToContextHistory = (sessionKey, role, content) => {
  const history = getContextHistory(sessionKey);
  history.push({ role, content });
  
  // Trim history if total chars exceed limit
  let totalChars = history.reduce((sum, msg) => sum + (msg.content?.length || 0), 0);
  while (totalChars > MAX_CONTEXT_CHARS && history.length > 1) {
    const removed = history.shift();
    totalChars -= removed.content?.length || 0;
  }
  
  contextHistoryCache.set(sessionKey, history);
  return history;
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
    const sessionKey = `${adcpAuth}:${mcpServerUrl}:${sessionId}`;

    // Handle clear history command
    if (body.clearHistory) {
      clearContextHistory(sessionKey);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: true, message: 'History cleared' }));
      return;
    }

    // Add user message to history and get full context
    const messages = addToContextHistory(sessionKey, 'user', body.prompt);

    const result = await streamText({
      model: getModel(aiModel),
      messages: messages,
      temperature: 0, // Recommended for tool calls
      tools: await getHttpClientTools(adcpAuth, mcpServerUrl),
      onError: (onError) => {
        console.log({ onError })
      },
      onFinish: (onFinish) => {
        console.log({ onFinish })
        // Add assistant response to history
        if (onFinish.text) {
          addToContextHistory(sessionKey, 'assistant', onFinish.text);
        }
      },
      onStepFinish: (onStepFinish) => {
        console.log({ onStepFinish })
      },
      onAbort: (onAbort) => {
        console.log({ onAbort })
      },
      maxSteps: 10,
      stopWhen: stepCountIs(10),
    });

    for await (const part of result.fullStream) {
      res.write(JSON.stringify(part) + '\n');
    }
    res.end()

    return;
  }

  try {
    const html = await readFile(join(__dirname, 'index.html'));
    res.setHeader('Content-Type', 'text/html');
    res.end(html);
  } catch (err) {
    res.statusCode = 500;
    res.end('Error loading index.html');
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${ PORT }`);
});
