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
const httpClientToolsCache = new NodeCache({ stdTTL: 3600, checkperiod: 1800, useClones: false });
const contextHistoryCache = new NodeCache({ stdTTL: 3600, checkperiod: 1800, useClones: false });
const validAdcpAuths = process.env.VALID_ADCP_AUTH_KEYS?.split(',');

if(process.env.MCP_SERVER_CHOICES){
  console.debug("process.env.MCP_SERVER_CHOICES:", process.env.MCP_SERVER_CHOICES);
}
const MAX_CONTEXT_CHARS = 200_000;

const SYSTEM_PROMPT = `You are a helpful AI assistant.

Your goal is to help the user achieve their task as efficiently and accurately as possible.

When tools are available, prefer using them whenever they can improve the quality, accuracy, or efficiency of the response. 
Only answer directly without tools if a tool would not meaningfully help.

Follow the user's instructions carefully, ask clarifying questions when necessary, and provide clear, concise responses.`;

// Get context history for a user session
const getContextHistory = (sessionKey) => {
  return contextHistoryCache.get(sessionKey) || [];
};

// Calculate the character size of a message (handles text, tool calls, and tool results)
const getMessageSize = (msg) => {
  if (typeof msg.content === 'string') {
    return msg.content.length;
  }
  if (Array.isArray(msg.content)) {
    return msg.content.reduce((sum, part) => {
      if (part.type === 'text') return sum + (part.text?.length || 0);
      if (part.type === 'tool-call') return sum + JSON.stringify(part.input || {}).length + (part.toolName?.length || 0);
      if (part.type === 'tool-result') return sum + JSON.stringify(part.output?.value || '').length;
      return sum;
    }, 0);
  }
  return 0;
};

// Add message to context history and trim if needed
const addToContextHistory = (sessionKey, message) => {
  const history = getContextHistory(sessionKey);
  history.push(message);
  
  // Trim history if total chars exceed limit
  let totalChars = history.reduce((sum, msg) => sum + getMessageSize(msg), 0);
  let messagesRemoved = 0;
  while (totalChars > MAX_CONTEXT_CHARS && history.length > 1) {
    const removed = history.shift();
    totalChars -= getMessageSize(removed);
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
    const sessionKey = `${adcpAuth}:${mcpServerUrl}:${sessionId}`;

    // Handle clear history command
    if (body.clearHistory) {
      clearContextHistory(sessionKey);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: true, message: 'History cleared' }));
      return;
    }

    // Add user message to history and get full context
    const { history: messages, messagesRemoved } = addToContextHistory(sessionKey, { role: 'user', content: body.prompt });

    // If messages were truncated, send a warning to the client first
    if (messagesRemoved > 0) {
      res.write(JSON.stringify({ 
        type: 'context-truncated', 
        messagesRemoved,
        message: `Context window limit reached. ${messagesRemoved} older message${messagesRemoved > 1 ? 's were' : ' was'} removed from context.`
      }) + '\n');
    }

    const result = await streamText({
      model: getModel(aiModel),
      system: SYSTEM_PROMPT,
      messages: messages,
      temperature: 0, // Recommended for tool calls
      tools: await getHttpClientTools(adcpAuth, mcpServerUrl),
      onError: (onError) => {
        console.log({ onError })
      },
      onFinish: (onFinish) => {
        console.log({ onFinish })
      },
      onStepFinish: (stepResult) => {
        console.log({ onStepFinish: stepResult })
        
        // Build the assistant message content array for this step
        const assistantContent = [];
        
        // Add text if present
        if (stepResult.text) {
          assistantContent.push({ type: 'text', text: stepResult.text });
        }
        
        // Add tool calls if present
        if (stepResult.toolCalls && stepResult.toolCalls.length > 0) {
          for (const toolCall of stepResult.toolCalls) {
            assistantContent.push({
              type: 'tool-call',
              toolCallId: toolCall.toolCallId,
              toolName: toolCall.toolName,
              input: toolCall.args ?? {}, // SDK requires 'input', fallback to empty object
            });
          }
        }
        
        // Add assistant message to history if there's content
        if (assistantContent.length > 0) {
          addToContextHistory(sessionKey, { role: 'assistant', content: assistantContent });
        }
        
        // Add tool results as separate tool messages
        if (stepResult.toolResults && stepResult.toolResults.length > 0) {
          for (const toolResult of stepResult.toolResults) {
            addToContextHistory(sessionKey, {
              role: 'tool',
              content: [{
                type: 'tool-result',
                toolCallId: toolResult.toolCallId,
                toolName: toolResult.toolName,
                output: { type: 'json', value: toolResult.output ?? null },
              }],
            });
          }
        }
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
