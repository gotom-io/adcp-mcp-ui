import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from "fs";
import { getLogger } from './services/logger.mjs';
import { handleGetSettings, handlePostSettings } from './routes/settings.mjs';
import { handleChat } from './routes/chat.mjs';
import { handleLogs } from './routes/logs.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const logger = getLogger();

if(process.env.MCP_SERVER_CHOICES){
  logger.debug("process.env.MCP_SERVER_CHOICES:", process.env.MCP_SERVER_CHOICES);
}

const server = createServer(async (req, res) => {
  let logger = getLogger();
  logger.setMcpRequestId('-');

  if (req.method === 'GET' && req.url === '/api/settings') {
    handleGetSettings(req, res);
    return;
  }

  if (req.method === 'POST' && req.url === '/api/settings') {
    await handlePostSettings(req, res);
    return;
  }

  if (req.method === 'GET' && req.url === '/') {
    const template = fs.readFileSync("./index.template.html", "utf8");
    let chatConfig = {};
    if(process.env.MCP_SERVER_CHOICES){
      chatConfig.serverChoices = JSON.parse(process.env.MCP_SERVER_CHOICES || "[]");
    }
    if(! chatConfig.serverChoices){
      chatConfig.serverChoices = [{url: "https://dev-demo-mcp.gotom.io", label: "Dev Demo"},{url: "https://dev-goldbach-mcp.gotom.io", label: "Dev Goldbach"}];
    }
    const html = template.replaceAll("{{ WINDOW_CHAT_CONFIG }}", JSON.stringify(chatConfig, ' ', 2));
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/api/logs') {
    await handleLogs(req, res);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/chat') {
    await handleChat(req, res);
    return;
  }

  // Serve static files
  const urlPath = req.url.split('?')[0];
  let staticFile = null;

  if (urlPath === '/styles.css') {
    staticFile = { file: '../styles.css', contentType: 'text/css' };
  } else if (urlPath.startsWith('/frontend/')) {
    staticFile = { file: '../' + urlPath.slice(1), contentType: 'application/javascript' };
  } else if (urlPath.startsWith('/shared/')) {
    staticFile = { file: '../' + urlPath.slice(1), contentType: 'application/javascript' };
  } else if (urlPath === '/app.js') {
    staticFile = { file: 'frontend/app.js', contentType: 'application/javascript' };
  } else if (urlPath === '/shared.mjs') {
    staticFile = { file: 'shared/shared.mjs', contentType: 'application/javascript' };
  }

  if(staticFile){
    try {
      const content = await readFile(join(__dirname, staticFile.file));
      res.setHeader('Content-Type', staticFile.contentType);
      res.end(content);
    } catch (err) {
      res.statusCode = 500;
      res.end(`Error loading ${staticFile.file}`);
    }
  } else {
    res.statusCode = 404;
    res.end('Not Found');
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  logger.log(`Server running at http://localhost:${ PORT }`);
});
