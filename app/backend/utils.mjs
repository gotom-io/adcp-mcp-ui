import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stepCountIs, streamText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';
import * as util from "node:util";

const __dirname = dirname(fileURLToPath(import.meta.url));

const validAdcpAuths = process.env.VALID_ADCP_AUTH_KEYS?.split(',');
const isLocal = process.env.GOTOM_ENV === 'local';

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
const createSecureCookie = (name, value, maxAge = 31536000) => {
  const secureFlag = isLocal ? '' : '; Secure';
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly${secureFlag}; SameSite=Strict`;
};

const getHeaderInfo = (req, res) => {
  const adcpAuth = req.headers['x-adcp-auth'];
  if (!adcpAuth || validAdcpAuths.indexOf(adcpAuth) === -1) {
    res.statusCode = 403;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Forbidden: missing/invalid authentication (add the API key to the .env variable VALID_ADCP_AUTH_KEYS)' }));
    return res;
  }

  const mcpServerUrl = req.headers['x-mcp-server'];
  if (!mcpServerUrl) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'MCP server missing' }));
    return res;
  }

  const aiModel = req.headers['x-ai-model'] || 'anthropic:claude-sonnet-4-6';
  const sessionId = req.headers['x-session-id'];

  if (!sessionId) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Session ID missing' }));
    return res;
  }
  return { adcpAuth, mcpServerUrl, aiModel, sessionId };
};

const getBody = async (req) => {
  return await new Promise((resolve) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => resolve(JSON.parse(data)));
  });
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

export {
  __dirname,
  parseCookies,
  createSecureCookie,
  getHeaderInfo,
  getBody,
  getModel,
  validAdcpAuths
};
