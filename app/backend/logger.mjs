import fs from 'node:fs';
import path from 'node:path';
import * as util from 'node:util';
import NodeCache from 'node-cache';
import { getMcpSessionIdShort } from '../shared/session.mjs';

const NO_ID_FOUND = '-';
const LOG_FILE = process.env.LOG_FILE || '/app/adcp-mcp-ui-logs/server.log';

fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });

const loggerCache = new NodeCache({ stdTTL: 3600 * 12, checkperiod: 1800, useClones: false });

const formatStdout = (args) =>
  args.map(arg =>
    typeof arg === 'object' ? util.inspect(arg, { depth: 5, colors: false, compact: false }) : String(arg)
  ).join(' ');

const formatLog = (args) =>
  args.map(arg => (typeof arg === 'object' ? JSON.stringify(arg) : String(arg))).join(' ');

const buildLine = (level, sessionId, requestId, message) => {
  const shortSessionId = sessionId !== NO_ID_FOUND ? getMcpSessionIdShort(sessionId) : NO_ID_FOUND;
  return `[${new Date().toISOString()}] [${level}] [sessionId:${shortSessionId}] [requestId:${requestId}] ${message}\n`;
};

const writeLine = (level, sessionId, requestId, args) => {
  const stdLine = buildLine(level, sessionId, requestId, formatStdout(args));
  const fileLine = buildLine(level, sessionId, requestId, formatLog(args));

  if (level === 'ERROR') {
    process.stderr.write(stdLine);
  } else {
    process.stdout.write(stdLine);
  }
  logStream.write(fileLine);
};

export const getLogger = (sessionId = NO_ID_FOUND) => {
  const cached = loggerCache.get(sessionId);
  if (cached) return cached;

  const state = { sessionId, requestId: NO_ID_FOUND };

  const logger = {
    setMcpRequestId: (id) => { state.requestId = id; },
    error: (...args) => writeLine('ERROR', state.sessionId, state.requestId, args),
    warn:  (...args) => writeLine('WARN',  state.sessionId, state.requestId, args),
    info:  (...args) => writeLine('INFO',  state.sessionId, state.requestId, args),
    log:   (...args) => writeLine('LOG',   state.sessionId, state.requestId, args),
    debug: (...args) => writeLine('DEBUG', state.sessionId, state.requestId, args),
  };

  loggerCache.set(sessionId, logger);
  return logger;
};

export { NO_ID_FOUND };
