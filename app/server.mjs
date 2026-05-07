import { createServer } from 'node:http';
import { createLogger, NO_ID_FOUND } from './backend/logger.mjs';
import { getHeaderInfo } from './backend/utils.mjs';
import { getHomePage } from './backend/routes/home.mjs';
import { getSettings, saveSettings } from './backend/routes/settings.mjs';
import { getLogs } from './backend/routes/logs.mjs';
import { handleChat } from './backend/routes/chat.mjs';
import { serveStatic } from './backend/routes/static.mjs';

const server = createServer(async (req, res) => {
  const logger = createLogger();
  logger.setMcpRequestId(NO_ID_FOUND);

  // GET /api/settings - Read settings from HttpOnly cookies
  if (req.method === 'GET' && req.url === '/api/settings') {
    getSettings(req, res);
    return;
  }

  // POST /api/settings - Save settings as HttpOnly cookies
  if (req.method === 'POST' && req.url === '/api/settings') {
    saveSettings(req, res);
    return;
  }

  // GET / - Serve home page
  if (req.method === 'GET' && req.url === '/') {
    getHomePage(req, res);
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  // GET /api/logs - Fetch logs
  if (req.method === 'GET' && url.pathname === '/api/logs') {
    await getLogs(req, res);
    return;
  }

  // POST /api/chat - Handle chat
  if (req.method === 'POST' && req.url === '/api/chat') {
    await handleChat(req, res);
    return;
  }

  // Serve static files
  await serveStatic(req, res);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  createLogger().log(`Server running at http://localhost:${PORT}`);
});
