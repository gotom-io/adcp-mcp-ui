// /api/settings - Read and write user preferences as HttpOnly cookies.

import { parseCookies, createSecureCookie } from '../cookies.mjs';
import { readJsonBody, sendJson } from '../http-utils.mjs';

const SETTING_NAMES = ['adcp_auth', 'mcp_server', 'ai_model'];

export const handleGetSettings = (req, res) => {
  const cookies = parseCookies(req);
  const settings = SETTING_NAMES.reduce((acc, name) => {
    acc[name] = cookies[name] || '';
    return acc;
  }, {});
  sendJson(res, 200, settings);
};

export const handlePostSettings = async (req, res) => {
  const body = await readJsonBody(req);
  const cookiesToSet = SETTING_NAMES
    .filter(name => body[name] !== undefined)
    .map(name => createSecureCookie(name, body[name]));

  if (cookiesToSet.length > 0) {
    res.setHeader('Set-Cookie', cookiesToSet);
  }
  sendJson(res, 200, { success: true });
};
