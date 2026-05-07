import { getLogger } from '../services/logger.mjs';

const validAdcpAuths = process.env.VALID_ADCP_AUTH_KEYS?.split(',');

// Helper to parse cookies from request
export const parseCookies = (req) => {
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
export const createSecureCookie = (name, value, maxAge = 31536000) => {
  const secureFlag = isLocal ? '' : '; Secure';
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly${secureFlag}; SameSite=Strict`;
};

export const handleGetSettings = (req, res) => {
  const cookies = parseCookies(req);
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({
    adcp_auth: cookies.adcp_auth || '',
    mcp_server: cookies.mcp_server || '',
    ai_model: cookies.ai_model || '',
  }));
};

export const handlePostSettings = async (req, res) => {
  const body = await new Promise((resolve) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => resolve(JSON.parse(data)));
  });

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
};

export const getHeaderInfo = (req, res) => {
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
};
