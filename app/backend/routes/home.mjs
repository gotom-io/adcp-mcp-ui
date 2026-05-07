import fs from "fs";
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const getHomePage = (req, res) => {
  // Go up two levels: /app/backend/routes/ -> /app/
  const template = fs.readFileSync(path.join(__dirname, '../../frontend/index.template.html'), "utf8");
  let chatConfig = {};

  if (process.env.MCP_SERVER_CHOICES) {
    chatConfig.serverChoices = JSON.parse(process.env.MCP_SERVER_CHOICES || "[]");
  }

  if (!chatConfig.serverChoices) {
    chatConfig.serverChoices = [
      { url: "https://dev-demo-mcp.gotom.io", label: "Dev Demo" },
      { url: "https://dev-goldbach-mcp.gotom.io", label: "Dev Goldbach" }
    ];
  }

  const html = template.replaceAll("{{ WINDOW_CHAT_CONFIG }}", JSON.stringify(chatConfig, ' ', 2));

  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(html);
};

export { getHomePage };
