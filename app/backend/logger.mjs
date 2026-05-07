import fs from "fs";
import path from 'node:path';
import * as util from "node:util";
import NodeCache from 'node-cache';
import { getMcpSessionIdShort } from "../shared.mjs";

const LOG_FILE = process.env.LOG_FILE || '/app/adcp-mcp-ui-logs/server.log';
const NO_ID_FOUND = '-';

// Ensure log directory exists
fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });

const loggerCache = new NodeCache({ stdTTL: 3600 * 12, checkperiod: 1800, useClones: false });

const createLogger = (sessionId = NO_ID_FOUND) => {
  if (loggerCache.has(sessionId)) {
    return loggerCache.get(sessionId);
  }

  const logger = {
    requestId: NO_ID_FOUND,
    sessionId,

    setMcpRequestId(id) {
      this.requestId = id;
    },

    error: (...args) => write('ERROR', logger, ...args),
    warn: (...args) => write('WARN', logger, ...args),
    info: (...args) => write('INFO', logger, ...args),
    log: (...args) => write('LOG', logger, ...args),
    debug: (...args) => write('DEBUG', logger, ...args),
  };

  loggerCache.set(sessionId, logger);
  return logger;
};

const write = (level, logger, ...args) => {
  const shortSessionId = logger.sessionId !== NO_ID_FOUND 
    ? getMcpSessionIdShort(logger.sessionId) 
    : NO_ID_FOUND;

  const messageStdout = args.map(arg =>
    typeof arg === 'object' ? util.inspect(arg, { depth: 5, colors: false, compact: false }) : String(arg)
  ).join(' ');

  const messageLog = args.map(arg =>
    typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
  ).join(' ');

  const lineStd =
    `[${new Date().toISOString()}] ` +
    `[${level}] ` +
    `[sessionId:${shortSessionId}] ` +
    `[requestId:${logger.requestId}] ` +
    `${messageStdout}\n`;

  const lineLog =
    `[${new Date().toISOString()}] ` +
    `[${level}] ` +
    `[sessionId:${shortSessionId}] ` +
    `[requestId:${logger.requestId}] ` +
    `${messageLog}\n`;

  if (level === 'ERROR') {
    process.stderr.write(lineStd);
  } else {
    process.stdout.write(lineStd);
  }

  logStream.write(lineLog);
};

export { createLogger, NO_ID_FOUND };
