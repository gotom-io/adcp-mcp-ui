// Thin wrappers around fetch() for the backend API.

const jsonHeaders = { 'Content-Type': 'application/json' };

export const fetchSettings = async () => {
  const res = await fetch('/api/settings');
  return res.json();
};

export const saveSetting = async (name, value) => {
  await fetch('/api/settings', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ [name]: value }),
  });
};

export const buildAuthHeaders = ({ authToken, mcpServer, aiModel, sessionId }) => ({
  'Content-Type': 'application/json',
  'x-adcp-auth': authToken,
  'x-mcp-server': mcpServer,
  'x-ai-model': aiModel,
  'x-session-id': sessionId,
});

export const searchLogs = async (headers, query) => {
  const params = new URLSearchParams({ query });
  const res = await fetch(`/api/logs?${params.toString()}`, { method: 'GET', headers });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to search logs');
  return data;
};

export const clearChatHistory = async (headers) => {
  await fetch('/api/chat', {
    method: 'POST',
    headers,
    body: JSON.stringify({ clearHistory: true }),
  });
};

export const streamChat = async (headers, prompt) => {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers,
    body: JSON.stringify({ prompt }),
  });

  if (!res.ok) {
    const errText = await res.text();
    try {
      const json = JSON.parse(errText);
      throw new Error(json.error || `Request failed with status ${res.status}`);
    } catch {
      throw new Error(errText || `Request failed with status ${res.status}`);
    }
  }

  return res;
};

/**
 * Read an NDJSON stream from a fetch Response, calling onPart() for each parsed JSON object.
 */
export const consumeNdjsonStream = async (response, onPart) => {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value, { stream: true });
    const lines = chunk.split('\n').filter(Boolean);

    for (const line of lines) {
      try {
        onPart(JSON.parse(line));
      } catch {
        // Partial chunk - safe to skip.
      }
    }
  }
};
