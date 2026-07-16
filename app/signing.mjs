/**
 * RFC 9421 request signing for the buyer → seller MCP connection.
 *
 * Signing is OPT-IN via environment (this is a public repo — no key
 * material lives in the codebase, not even test keys):
 *
 *   ADCP_BUYER_PRIVATE_JWK_FILE  path to a JSON file holding the private
 *                                JWK (ed25519, with `d`) — the recommended
 *                                way; keep the file under app/secrets/
 *                                (gitignored). Generate one with
 *                                `node scripts/gen-buyer-key.mjs`.
 *   ADCP_BUYER_PRIVATE_JWK       alternative: the private JWK inline as a
 *                                single-line JSON string
 *   ADCP_BUYER_KID               key id published to the seller (must match
 *                                the JWK's `kid`)
 *   ADCP_BUYER_AGENT_URL         optional; informational agent URL stamped
 *                                in the signature context
 *   ADCP_SIGNING_PASSWORD        REQUIRED for signature-only sessions: the
 *                                shared password a browser user must enter
 *                                instead of an API key. Without it, the
 *                                signing key would be usable by ANYONE who
 *                                can reach this (possibly public) UI — the
 *                                key authenticates this server, not the
 *                                human. Unset ⇒ signature-only sessions are
 *                                refused (fail closed); API-key sessions
 *                                still get their requests signed on top.
 *
 * When neither key source is configured, everything degrades to plain
 * fetch and the UI behaves exactly as before (API-key auth only).
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
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildCapabilityCacheKey,
  createAgentSignedFetch,
  defaultCapabilityCache,
} from '@adcp/sdk/signing';

// Relative ADCP_BUYER_PRIVATE_JWK_FILE paths resolve against THIS directory
// (the app dir), so `secrets/buyer-private.jwk` works both in docker
// (workdir /app) and when running server.mjs from anywhere on the host.
const APP_DIR = dirname(fileURLToPath(import.meta.url));

export function signingEnabled() {
  return Boolean(
    (process.env.ADCP_BUYER_PRIVATE_JWK_FILE || process.env.ADCP_BUYER_PRIVATE_JWK) &&
      process.env.ADCP_BUYER_KID,
  );
}

export function signingPasswordConfigured() {
  return Boolean(process.env.ADCP_SIGNING_PASSWORD);
}

/**
 * Signature-only sessions are offered to the browser only when BOTH the
 * signing key and the gate password are configured — otherwise anyone who
 * can reach the UI could sign as this buyer without any credential.
 */
export function signatureSessionsAvailable() {
  return signingEnabled() && signingPasswordConfigured();
}

/**
 * The PUBLIC half of the configured buyer key — served at
 * /.well-known/jwks.json. Derived from the private JWK by OMITTING the
 * secret scalar `d` (allowlist copy: the served object is built from named
 * public fields only, so it structurally cannot leak `d`).
 */
export function publicJwkFromPrivate() {
  const jwk = loadPrivateJwk();
  const { kty, crv, x, kid, alg, use, adcp_use } = jwk;
  return {
    kty,
    crv,
    x,
    ...(kid !== undefined && { kid }),
    ...(alg !== undefined && { alg }),
    ...(use !== undefined && { use }),
    ...(adcp_use !== undefined && { adcp_use }),
    key_ops: ['verify'],
  };
}

/**
 * Canonical public origin of this buyer (for brand.json's jwks_uri):
 * derived from ADCP_BUYER_AGENT_URL when set (e.g. https://adcp-ui.gotom.io),
 * else null — the well-known route then falls back to the request Host.
 */
export function buyerPublicOrigin() {
  const url = process.env.ADCP_BUYER_AGENT_URL;
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Constant-time check of the user-supplied signing password. */
export function signingPasswordOk(provided) {
  const expected = process.env.ADCP_SIGNING_PASSWORD;
  if (!expected || typeof provided !== 'string' || provided.length === 0) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function loadPrivateJwk() {
  let file = process.env.ADCP_BUYER_PRIVATE_JWK_FILE;
  if (file && !isAbsolute(file)) file = resolve(APP_DIR, file);
  const raw = file ? readFileSync(file, 'utf8') : process.env.ADCP_BUYER_PRIVATE_JWK;
  const jwk = JSON.parse(raw);
  if (!jwk.d) {
    throw new Error(
      `Buyer signing key ${file ? `file ${file}` : 'env ADCP_BUYER_PRIVATE_JWK'} is not a PRIVATE JWK (missing "d")`,
    );
  }
  return jwk;
}

function buyerSigningConfig() {
  return {
    kid: process.env.ADCP_BUYER_KID,
    alg: 'ed25519',
    private_key: loadPrivateJwk(),
    // Informational on the signer side; sellers resolving keys via
    // brand.json discovery would fetch this origin. Sellers that pin the
    // key directly (StaticJwksResolver) ignore it.
    agent_url: process.env.ADCP_BUYER_AGENT_URL ?? 'https://buyer.invalid',
    // Also sign ops the seller lists in `supported_for` (e.g. get_products:
    // unsigned works with baseline pricing, signed may unlock buyer-specific
    // pricing). Without this flag only required_for/warn_for ops are signed.
    sign_supported: true,
    // Cold-cache safety net: the spend-committing op is signed even when
    // capability priming failed (a cold cache otherwise means "sign nothing").
    always_sign: ['create_media_buy'],
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
