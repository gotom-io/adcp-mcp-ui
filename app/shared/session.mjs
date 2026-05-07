// Session ID helpers shared between frontend and backend.
// Keep this file dependency-free so it can run in both Node and browser.

export const getMcpSessionIdShort = (sessionId) =>
  'sid_' + sessionId.slice(0, 8);
