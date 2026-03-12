import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stepCountIs, streamText } from 'ai';
//import { openai } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';
import { createMCPClient } from '@ai-sdk/mcp';
import NodeCache from 'node-cache';

const __dirname = dirname(fileURLToPath(import.meta.url));
const httpClientToolsCache = new NodeCache({ stdTTL: 3600, checkperiod: 1800, useClones: false });
const validAdcpAuths = process.env.VALID_ADCP_AUTH_KEYS?.split(',');

const getHttpClientTools = async function(adcpAuth) {
  let clientTools = httpClientToolsCache.get(adcpAuth)
  if (!clientTools) {
    const httpClient = await createMCPClient({
      transport: {
        type: 'http',
        url: 'https://dev-demo-mcp.gotom.io',
        headers: {
          'x-adcp-auth': adcpAuth,
          'Authorization': `Basic ${Buffer.from(`${process.env.BASIC_AUTH_USER}:${process.env.BASIC_AUTH_PASS}`).toString('base64')}`
        },
      },
    });
    clientTools = await httpClient.tools();
  }
  httpClientToolsCache.set(adcpAuth, clientTools);
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

    const body = await new Promise((resolve) => {
      let data = '';
      req.on('data', chunk => data += chunk);
      req.on('end', () => resolve(JSON.parse(data)));
    });

    console.log({ body })

    const result = await streamText({
      model: anthropic('claude-sonnet-4-6'),
      prompt: body.prompt,
      temperature: 0, // Recommended for tool calls
      tools: await getHttpClientTools(adcpAuth),
      onError: (onError) => {
        console.log({ onError })
      },
      onFinish: (onFinish) => {
        console.log({ onFinish })
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
