/**
 * RFC 9421 request signing for the buyer → seller MCP connection.
 *
 * Signing is OPT-IN via environment (this is a public repo — no key
 * material lives in the codebase, not even test keys):
 *
 *   ADCP_BUYER_PRIVATE_JWK   JSON-encoded private JWK (ed25519, with `d`)
 *   ADCP_BUYER_KID           key id published to the seller (must match
 *                            the JWK's `kid`)
 *   ADCP_BUYER_AGENT_URL     optional; informational agent URL stamped in
 *                            the signature context
 *
 * When the env vars are absent, everything degrades to plain fetch and the
 * UI behaves exactly as before (API-key auth only).
 *
 * Flow per seller URL:
 *   1. `primeSellerCapability` makes ONE unsigned `get_adcp_capabilities`
 *      call and stores the seller's `request_signing` block in the SDK's
 *      shared capability cache. Without this the signed fetch would sign
 *      nothing (cold cache = "seller requires nothing").
 *   2. `createBuyerSignedFetch` returns a fetch that transparently signs
 *      exactly the operations the seller advertised in `required_for` /
 *      `warn_for` and leaves everything else (initialize, tools/list,
 *      get_products, …) unsigned.
 */
import {
  buildCapabilityCacheKey,
  createAgentSignedFetch,
  defaultCapabilityCache,
} from '@adcp/sdk/signing';

export function signingEnabled() {
  return Boolean(process.env.ADCP_BUYER_PRIVATE_JWK && process.env.ADCP_BUYER_KID);
}

function buyerSigningConfig() {
  return {
    kid: process.env.ADCP_BUYER_KID,
    alg: 'ed25519',
    private_key: JSON.parse(process.env.ADCP_BUYER_PRIVATE_JWK),
    // Informational on the signer side; sellers resolving keys via
    // brand.json discovery would fetch this origin. Sellers that pin the
    // key directly (StaticJwksResolver) ignore it.
    agent_url: process.env.ADCP_BUYER_AGENT_URL ?? 'https://buyer.invalid',
  };
}

/**
 * Fetch the seller's capability advertisement (unsigned, as the spec
 * requires) and seed the SDK's shared capability cache so the signed fetch
 * knows which operations to sign. No-op when a fresh entry already exists
 * or signing is disabled.
 */
export async function primeSellerCapability(sellerMcpUrl, headers) {
  if (!signingEnabled()) return;
  const key = buildCapabilityCacheKey(sellerMcpUrl, undefined);
  const existing = defaultCapabilityCache.get(key);
  if (existing && !defaultCapabilityCache.isStale(existing)) return;

  let requestSigning;
  try {
    const res = await fetch(sellerMcpUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'cap-priming',
        method: 'tools/call',
        params: { name: 'get_adcp_capabilities', arguments: {} },
      }),
    });
    const raw = await res.text();
    const jsonText = raw.startsWith('event:') || raw.startsWith('data:')
      ? raw.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('')
      : raw;
    const body = JSON.parse(jsonText);
    requestSigning = body?.result?.structuredContent?.request_signing;
  } catch (err) {
    // Fail open, exactly like the SDK's own priming helper: signing simply
    // stays off for this seller until the next successful priming attempt.
    console.warn(`[signing] capability priming failed for ${sellerMcpUrl}: ${err?.message ?? err}`);
  }
  defaultCapabilityCache.set(key, {
    requestSigning,
    adcpVersion: 3,
    fetchedAt: Math.floor(Date.now() / 1000),
    // On failure, retry priming after a short window instead of caching
    // "no signing" for the full default lifetime.
    ...(requestSigning ? {} : { staleAt: Math.floor(Date.now() / 1000) + 60 }),
  });
  if (requestSigning) {
    console.log(`[signing] seller ${sellerMcpUrl} requires signatures for: ${JSON.stringify(requestSigning.required_for ?? [])}`);
  }
}

/**
 * A fetch that signs outbound MCP calls per the seller's advertised
 * request_signing capability (plain fetch when signing is disabled).
 * Call `primeSellerCapability` first.
 */
export function createBuyerSignedFetch(sellerMcpUrl) {
  if (!signingEnabled()) return fetch;
  return createAgentSignedFetch({
    signing: buyerSigningConfig(),
    sellerAgentUri: sellerMcpUrl,
  });
}
