// GET / - Render the index template with injected window.chat_config.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = join(__dirname, '..', '..', 'frontend', 'index.template.html');

const DEFAULT_SERVER_CHOICES = [
  { url: 'https://dev-demo-mcp.gotom.io', label: 'Dev Demo' },
  { url: 'https://dev-goldbach-mcp.gotom.io', label: 'Dev Goldbach' },
];

const buildChatConfig = () => {
  const raw = process.env.MCP_SERVER_CHOICES;
  if (!raw) return { serverChoices: DEFAULT_SERVER_CHOICES };

  try {
    const parsed = JSON.parse(raw);
    return { serverChoices: parsed.length ? parsed : DEFAULT_SERVER_CHOICES };
  } catch {
    return { serverChoices: DEFAULT_SERVER_CHOICES };
  }
};

export const handleIndex = (req, res) => {
  const template = readFileSync(TEMPLATE_PATH, 'utf8');
  const html = template.replaceAll('{{ WINDOW_CHAT_CONFIG }}', JSON.stringify(buildChatConfig()));
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(html);
};
