import { parseCookies, createSecureCookie } from '../utils.mjs';

const getSettings = (req, res) => {
  const cookies = parseCookies(req);
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({
    adcp_auth: cookies.adcp_auth || '',
    mcp_server: cookies.mcp_server || '',
    ai_model: cookies.ai_model || '',
  }));
};

const saveSettings = async (req, res) => {
  let data = '';
  req.on('data', chunk => data += chunk);
  req.on('end', () => {
    const body = JSON.parse(data);
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
  });
};

export { getSettings, saveSettings };
