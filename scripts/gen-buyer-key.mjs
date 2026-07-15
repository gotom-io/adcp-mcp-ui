#!/usr/bin/env node
/**
 * Generate an ed25519 buyer signing keypair for RFC 9421 request signing.
 *
 *   node scripts/gen-buyer-key.mjs [kid]
 *
 * Writes the PRIVATE JWK to app/secrets/buyer-private.jwk (gitignored,
 * chmod 600) and prints the PUBLIC JWK — hand that to the seller so they
 * can register it (the seller maps your kid to a principal).
 *
 * Then configure .env:
 *   ADCP_BUYER_PRIVATE_JWK_FILE=app/secrets/buyer-private.jwk
 *   ADCP_BUYER_KID=<the kid>
 */
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const kid = process.argv[2] ?? `buyer-${new Date().getFullYear()}-${Date.now().toString(36)}`;
const outFile = join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'secrets', 'buyer-private.jwk');

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const common = { kid, alg: 'EdDSA', use: 'sig', adcp_use: 'request-signing' };
const publicJwk = { ...publicKey.export({ format: 'jwk' }), ...common, key_ops: ['verify'] };
const privateJwk = { ...privateKey.export({ format: 'jwk' }), ...common, key_ops: ['sign'] };

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify(privateJwk, null, 2) + '\n', { mode: 0o600 });

console.log(`Private JWK written to ${outFile} (never share or commit this file)\n`);
console.log('PUBLIC JWK — register this with the seller:\n');
console.log(JSON.stringify(publicJwk, null, 2));
console.log(`\nAdd to .env:\n  ADCP_BUYER_PRIVATE_JWK_FILE=app/secrets/buyer-private.jwk\n  ADCP_BUYER_KID=${kid}`);
