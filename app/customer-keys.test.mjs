import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CUSTOMER_DEFAULT_MODEL,
  customerServerAllowed,
  findCustomerProfile,
  parseCustomerKeys,
} from './customer-keys.mjs';

const VALID_ENTRY = {
  key: 'key-20min',
  label: '20 Minuten',
  servers: [{ url: 'https://test-20min-mcp.gotom.io/mcp', label: '20min (Test)' }],
};

describe('parseCustomerKeys', () => {
  it('returns [] when the env var is unset or blank', () => {
    assert.deepEqual(parseCustomerKeys(undefined), []);
    assert.deepEqual(parseCustomerKeys(''), []);
    assert.deepEqual(parseCustomerKeys('   '), []);
  });

  it('parses a valid entry and fills the defaults', () => {
    const [entry] = parseCustomerKeys(JSON.stringify([VALID_ENTRY]));
    assert.equal(entry.key, 'key-20min');
    assert.equal(entry.label, '20 Minuten');
    assert.deepEqual(entry.servers, VALID_ENTRY.servers);
    assert.equal(entry.model, CUSTOMER_DEFAULT_MODEL);
  });

  it('keeps an explicitly configured model', () => {
    const [entry] = parseCustomerKeys(JSON.stringify([{ ...VALID_ENTRY, model: 'anthropic:claude-opus-5' }]));
    assert.equal(entry.model, 'anthropic:claude-opus-5');
  });

  it('falls back to the url as server label', () => {
    const [entry] = parseCustomerKeys(JSON.stringify([{
      ...VALID_ENTRY,
      servers: [{ url: 'https://test-20min-mcp.gotom.io/mcp' }],
    }]));
    assert.equal(entry.servers[0].label, 'https://test-20min-mcp.gotom.io/mcp');
  });

  it('throws on malformed JSON', () => {
    assert.throws(() => parseCustomerKeys('{nope'), /not valid JSON/);
  });

  it('throws when the value is not an array', () => {
    assert.throws(() => parseCustomerKeys('{"key": "x"}'), /must be a JSON array/);
  });

  it('throws on a missing or empty key', () => {
    assert.throws(() => parseCustomerKeys(JSON.stringify([{ ...VALID_ENTRY, key: '' }])), /\.key/);
    assert.throws(() => parseCustomerKeys(JSON.stringify([{ servers: VALID_ENTRY.servers }])), /\.key/);
  });

  it('throws when servers is missing, empty, or has an entry without url', () => {
    assert.throws(() => parseCustomerKeys(JSON.stringify([{ key: 'x' }])), /\.servers/);
    assert.throws(() => parseCustomerKeys(JSON.stringify([{ key: 'x', servers: [] }])), /\.servers/);
    assert.throws(() => parseCustomerKeys(JSON.stringify([{ key: 'x', servers: [{ label: 'no url' }] }])), /\.url/);
  });
});

describe('findCustomerProfile', () => {
  const keys = parseCustomerKeys(JSON.stringify([VALID_ENTRY]));

  it('finds the profile for a customer key', () => {
    assert.equal(findCustomerProfile(keys, 'key-20min')?.label, '20 Minuten');
  });

  it('returns null for unknown or empty keys', () => {
    assert.equal(findCustomerProfile(keys, 'someone-else'), null);
    // An empty key must NEVER match — it would drag signature-only sessions
    // into customer mode.
    assert.equal(findCustomerProfile(keys, ''), null);
    assert.equal(findCustomerProfile(keys, undefined), null);
  });
});

describe('customerServerAllowed', () => {
  const [profile] = parseCustomerKeys(JSON.stringify([VALID_ENTRY]));

  it('allows the configured environments only', () => {
    assert.equal(customerServerAllowed(profile, 'https://test-20min-mcp.gotom.io/mcp'), true);
    assert.equal(customerServerAllowed(profile, 'https://dev-demo-mcp.gotom.io/mcp'), false);
    assert.equal(customerServerAllowed(profile, ''), false);
  });
});
