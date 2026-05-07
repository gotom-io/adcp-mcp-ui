// Small HTTP helpers: JSON body parsing, JSON responses, header validation.

const validAdcpAuths = process.env.VALID_ADCP_AUTH_KEYS?.split(',') || [];

export const readJsonBody = (req) =>
  new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });

export const sendJson = (res, statusCode, payload) => {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
};

export const sendError = (res, statusCode, message) =>
  sendJson(res, statusCode, { error: message });

/**
 * Validate request headers for authenticated API endpoints.
 * Returns { ok: true, info } or { ok: false } after sending the error response.
 */
export const getHeaderInfo = (req, res) => {
  const adcpAuth = req.headers['x-adcp-auth'];
  if (!adcpAuth || !validAdcpAuths.includes(adcpAuth)) {
    sendError(res, 403, 'Forbidden: missing/invalid authentication (add the API key to the .env variable VALID_ADCP_AUTH_KEYS)');
    return { ok: false };
  }

  const mcpServerUrl = req.headers['x-mcp-server'];
  if (!mcpServerUrl) {
    sendError(res, 400, 'MCP server missing');
    return { ok: false };
  }

  const sessionId = req.headers['x-session-id'];
  if (!sessionId) {
    sendError(res, 400, 'Session ID missing');
    return { ok: false };
  }

  const aiModel = req.headers['x-ai-model'] || 'anthropic:claude-sonnet-4-6';

  return { ok: true, info: { adcpAuth, mcpServerUrl, aiModel, sessionId } };
};
