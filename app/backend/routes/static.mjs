import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Define static files with paths relative to /app/ (where server.mjs runs)
const staticFiles = {
  '/frontend/styles.css': { file: 'frontend/styles.css', contentType: 'text/css' },
  '/frontend/app.js': { file: 'frontend/app.js', contentType: 'application/javascript' },
  '/frontend/shared.mjs': { file: 'frontend/shared.mjs', contentType: 'application/javascript' },
  '/frontend/constants.js': { file: 'frontend/constants.js', contentType: 'application/javascript' },
  '/frontend/helpers.js': { file: 'frontend/helpers.js', contentType: 'application/javascript' },
  '/frontend/composables/useSettings.js': { file: 'frontend/composables/useSettings.js', contentType: 'application/javascript' },
  '/frontend/composables/useChat.js': { file: 'frontend/composables/useChat.js', contentType: 'application/javascript' },
  '/frontend/composables/useLogs.js': { file: 'frontend/composables/useLogs.js', contentType: 'application/javascript' },
  '/backend/shared.mjs': { file: 'frontend/shared.mjs', contentType: 'application/javascript' },
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const serveStatic = async (req, res) => {
  // Strip query string for static file matching
  const urlPath = req.url.split('?')[0];
  const staticFile = staticFiles[urlPath];

  if (staticFile) {
    try {
      // Go up two levels from backend/routes/ to /app/
      const filePath = join(__dirname, '../../', staticFile.file);
      console.log('Trying to read:', filePath);
      const content = await readFile(filePath);
      res.setHeader('Content-Type', staticFile.contentType);
      res.end(content);
    } catch (err) {
      console.error('Error loading static file:', err);
      res.statusCode = 500;
      res.end(`Error loading ${staticFile.file}: ${err.message}`);
    }
  } else {
    res.statusCode = 404;
    res.end('Not Found');
  }
};

export { serveStatic };
