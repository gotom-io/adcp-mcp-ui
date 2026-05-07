// HTTP server: routes requests to focused handler modules.

import { createServer } from 'node:http';
import { getLogger } from './logger.mjs';
import { handleGetSettings, handlePostSettings } from './routes/settings.mjs';
import { handleIndex } from './routes/index.mjs';
import { handleGetLogs } from './routes/logs.mjs';
import { handlePostChat } from './routes/chat.mjs';
import { tryServeStatic } from './routes/static.mjs';

const PORT = process.env.PORT || 3000;

const route = async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { method } = req;
  const { pathname } = url;

  // API endpoints
  if (method === 'GET'  && pathname === '/api/settings') return handleGetSettings(req, res);
  if (method === 'POST' && pathname === '/api/settings') return handlePostSettings(req, res);
  if (method === 'GET'  && pathname === '/api/logs')     return handleGetLogs(req, res, url);
  if (method === 'POST' && pathname === '/api/chat')     return handlePostChat(req, res);

  // Index
  if (method === 'GET' && pathname === '/') return handleIndex(req, res);

  // Static assets
  if (method === 'GET' && (await tryServeStatic(req, res))) return;

  res.statusCode = 404;
  res.end('Not Found');
};

export const startServer = () => {
  const logger = getLogger();
  if (process.env.MCP_SERVER_CHOICES) {
    logger.debug('process.env.MCP_SERVER_CHOICES:', process.env.MCP_SERVER_CHOICES);
  }

  const server = createServer((req, res) => {
    route(req, res).catch((err) => {
      logger.error('Unhandled route error:', err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    });
  });

  server.listen(PORT, () => {
    logger.log(`Server running at http://localhost:${PORT}`);
  });

  return server;
};
