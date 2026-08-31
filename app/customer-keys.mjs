/**
 * Customer mode (GOT-12664): early-access customers get an agency API key that
 * locks the UI down to their own seller environments. The key IS the mode
 * switch — no per-customer deployment or URL scheme needed. Everything here is
 * pure config parsing/lookup so it stays unit-testable without the server.
 *
 * ADCP_CUSTOMER_KEYS is a JSON array:
 * [
 *   {
 *     "key":     "<agency API key of that instance>",
 *     "label":   "Velocity Media (demo agency)",
 *     "servers": [{ "url": "https://dev-demo-mcp.gotom.io/mcp", "label": "Demo" }],
 *     "model":   "anthropic:claude-sonnet-5"        // optional — falls back to the default below
 *   }
 * ]
 */

export const CUSTOMER_DEFAULT_MODEL = 'anthropic:claude-sonnet-5';

/**
 * Parse and validate the ADCP_CUSTOMER_KEYS env value. Throws on anything
 * malformed — a half-read allowlist must never boot, it would silently expose
 * foreign environments to a customer key.
 */
export function parseCustomerKeys(raw) {
  if (!raw || !raw.trim()) return [];

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`ADCP_CUSTOMER_KEYS is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('ADCP_CUSTOMER_KEYS must be a JSON array');
  }

  return parsed.map((entry, i) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`ADCP_CUSTOMER_KEYS[${i}] must be an object`);
    }
    if (typeof entry.key !== 'string' || !entry.key.trim()) {
      throw new Error(`ADCP_CUSTOMER_KEYS[${i}].key must be a non-empty string`);
    }
    if (!Array.isArray(entry.servers) || entry.servers.length === 0) {
      throw new Error(`ADCP_CUSTOMER_KEYS[${i}].servers must be a non-empty array`);
    }
    const servers = entry.servers.map((server, j) => {
      if (!server || typeof server.url !== 'string' || !server.url.trim()) {
        throw new Error(`ADCP_CUSTOMER_KEYS[${i}].servers[${j}].url must be a non-empty string`);
      }
      return { url: server.url, label: typeof server.label === 'string' && server.label ? server.label : server.url };
    });
    return {
      key: entry.key,
      label: typeof entry.label === 'string' ? entry.label : '',
      servers,
      model: typeof entry.model === 'string' && entry.model ? entry.model : CUSTOMER_DEFAULT_MODEL,
    };
  });
}

/** The customer profile a presented API key belongs to, or null. */
export function findCustomerProfile(customerKeys, adcpAuth) {
  if (!adcpAuth) return null;
  return customerKeys.find(entry => entry.key === adcpAuth) ?? null;
}

/** Whether a customer key may talk to the given MCP server URL. */
export function customerServerAllowed(profile, mcpServerUrl) {
  return profile.servers.some(server => server.url === mcpServerUrl);
}
