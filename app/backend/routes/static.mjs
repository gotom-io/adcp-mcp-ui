// Serve frontend static assets from app/frontend/.

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = join(__dirname, '..', '..', 'frontend');
const SHARED_DIR = join(__dirname, '..', '..', 'shared');

const JS = 'application/javascript';

// Map public URL → { dir, file, contentType }
const STATIC_FILES = {
  '/styles.css':      { dir: FRONTEND_DIR, file: 'styles.css',      contentType: 'text/css' },
  '/app.js':          { dir: FRONTEND_DIR, file: 'app.js',          contentType: JS },
  '/api-client.mjs':  { dir: FRONTEND_DIR, file: 'api-client.mjs',  contentType: JS },
  '/log-viewer.mjs':  { dir: FRONTEND_DIR, file: 'log-viewer.mjs',  contentType: JS },
  '/chat-store.mjs':  { dir: FRONTEND_DIR, file: 'chat-store.mjs',  contentType: JS },
  '/shared/session.mjs': { dir: SHARED_DIR, file: 'session.mjs',    contentType: JS },
};

export const tryServeStatic = async (req, res) => {
  const urlPath = req.url.split('?')[0];
  const entry = STATIC_FILES[urlPath];
  if (!entry) return false;

  try {
    const content = await readFile(join(entry.dir, entry.file));
    res.setHeader('Content-Type', entry.contentType);
    res.end(content);
  } catch {
    res.statusCode = 500;
    res.end(`Error loading ${entry.file}`);
  }
  return true;
};
