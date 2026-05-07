// Log highlighting helpers used by the log viewer panel.

const ERROR_KEYWORDS = [
  'error', 'warning', 'critical', 'fatal', 'fail', 'failed', 'failure',
  'missing', 'required', 'not found', 'undefined', 'none', 'denied', 'refused',
  'rejected', 'blocked', 'invalid', 'illegal', 'bad', 'wrong', 'corrupt',
  'corrupted', 'broken', 'crash', 'crashed', 'abort', 'aborted', 'killed',
  'segfault', 'panic', 'exception', 'traceback', 'timeout', 'expired',
  'exceeded', 'overflow', 'underflow', 'leak', 'deadlock', 'conflict',
  'duplicate', 'mismatch', 'unknown', 'unexpected', 'unauthorized', 'forbidden',
  'unavailable', 'unreachable', 'disconnected', 'lost', 'dropped', 'skipped',
  'ignored', 'deprecated', 'obsolete', 'insecure', 'vulnerable', 'violation',
  'permission', 'readonly', 'locked', 'busy', 'empty', 'stopped', 'suspended',
  'terminated', 'exit', 'quit',
];

const HIGHLIGHT_KEYWORDS = [
  'askAi', 'Sending to', 'Executing tool', 'Tool executed', 'account_id', 'success',
];

const errorRegex = new RegExp(`(${ERROR_KEYWORDS.join('|')})`, 'gi');
const keywordRegex = new RegExp(`(${HIGHLIGHT_KEYWORDS.join('|')})`, 'gi');

const filterLines = (lines, term) => {
  const needle = term.trim().toLowerCase();
  if (!needle) return lines;
  return lines.filter(line => line.toLowerCase().includes(needle));
};

const highlight = (text) =>
  text
    .replace(errorRegex,   '<span class="log-error">$1</span>')
    .replace(keywordRegex, '<span class="log-keyword">$1</span>');

/**
 * Build the highlighted log output (HTML string) from raw log lines and a filter term.
 */
export const buildHighlightedLogs = (logs, filterTerm) => {
  const lines = Array.isArray(logs) ? logs : [];
  if (lines.length === 0) return '';
  return highlight(filterLines(lines, filterTerm).join('\n'));
};
