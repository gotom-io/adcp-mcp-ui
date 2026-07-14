/**
 * Minimal MCP streamable-HTTP client transport with an injectable fetch.
 *
 * Exists because @ai-sdk/mcp's built-in `{type: 'http'}` transport calls the
 * global `fetch` directly and offers no hook to swap it — which is exactly
 * what RFC 9421 request signing needs (a fetch wrapper that adds
 * `Signature-Input`/`Signature` headers). `createMCPClient` accepts any
 * object implementing the MCPTransport interface (start/send/close +
 * onmessage/onerror/onclose), so this class mirrors the built-in
 * transport's POST semantics with `fetchImpl` in place of global fetch:
 *
 *   - POST each JSON-RPC message; propagate `mcp-session-id`.
 *   - 202 → accepted notification, nothing to deliver.
 *   - application/json response → deliver message(s).
 *   - text/event-stream response → deliver each SSE `message` event.
 *
 * The optional server-initiated GET/SSE listening stream of the spec is not
 * opened: this client only does request/response tool calls, and stateless
 * sellers don't support it anyway.
 */
export class SignedHttpTransport {
  /**
   * @param {{ url: string, headers?: Record<string,string>, fetchImpl?: typeof fetch }} options
   */
  constructor({ url, headers = {}, fetchImpl = fetch }) {
    this.url = url;
    this.headers = headers;
    this.fetchImpl = fetchImpl;
    this.sessionId = undefined;
    this.abortController = undefined;
    // Assigned by the MCP client after construction:
    this.onmessage = undefined;
    this.onerror = undefined;
    this.onclose = undefined;
  }

  async start() {
    if (this.abortController) {
      throw new Error('SignedHttpTransport already started');
    }
    this.abortController = new AbortController();
  }

  async close() {
    this.abortController?.abort();
    this.onclose?.();
  }

  /** @param {Record<string, unknown>} message JSON-RPC message */
  async send(message) {
    try {
      const headers = {
        ...this.headers,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
      };
      const response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(message),
        signal: this.abortController?.signal,
      });

      const sessionId = response.headers.get('mcp-session-id');
      if (sessionId) this.sessionId = sessionId;

      if (response.status === 202) return; // accepted notification

      if (!response.ok) {
        const text = await response.text().catch(() => null);
        throw new Error(`MCP endpoint returned HTTP ${response.status}: ${text}`);
      }

      if (!('id' in message)) return; // notification — no response expected

      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('application/json')) {
        const data = await response.json();
        for (const m of Array.isArray(data) ? data : [data]) this.onmessage?.(m);
        return;
      }
      if (contentType.includes('text/event-stream')) {
        await this.#deliverSseMessages(response);
        return;
      }
      throw new Error(`MCP endpoint returned unexpected content type: ${contentType}`);
    } catch (error) {
      if (error?.name === 'AbortError') return;
      this.onerror?.(error);
      throw error;
    }
  }

  /** Incrementally parse an SSE body, delivering each `message` event. */
  async #deliverSseMessages(response) {
    if (!response.body) throw new Error('text/event-stream response without body');
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += value;
        let sep;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const rawEvent = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          this.#deliverSseEvent(rawEvent);
        }
      }
      if (buffer.trim()) this.#deliverSseEvent(buffer);
    } finally {
      reader.releaseLock();
    }
  }

  #deliverSseEvent(rawEvent) {
    const lines = rawEvent.split('\n');
    const eventName = lines.find(l => l.startsWith('event:'))?.slice(6).trim() ?? 'message';
    const data = lines.filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n');
    if (eventName !== 'message' || !data) return;
    try {
      this.onmessage?.(JSON.parse(data));
    } catch (error) {
      this.onerror?.(new Error(`Failed to parse SSE message: ${error?.message ?? error}`));
    }
  }
}
