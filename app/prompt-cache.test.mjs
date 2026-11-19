import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { cachedSystemMessage, describeCacheUsage, withTurnBreakpoint } from './prompt-cache.mjs';

const EPHEMERAL = { type: 'ephemeral' };

describe('withTurnBreakpoint', () => {
  it('marks only the last message', () => {
    const marked = withTurnBreakpoint([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'second' },
    ]);

    assert.equal(marked[0].providerOptions, undefined);
    assert.equal(marked[1].providerOptions, undefined);
    assert.deepEqual(marked[2].providerOptions, { anthropic: { cacheControl: EPHEMERAL } });
  });

  it('leaves the stored history untouched, so breakpoints never pile up across turns', () => {
    const history = [{ role: 'user', content: 'first' }];

    withTurnBreakpoint(history);
    history.push({ role: 'assistant', content: 'answer' }, { role: 'user', content: 'second' });
    const marked = withTurnBreakpoint(history);

    assert.equal(history.some((message) => 'providerOptions' in message), false);
    assert.equal(marked.filter((message) => message.providerOptions).length, 1);
  });

  it('returns an empty history as it is', () => {
    assert.deepEqual(withTurnBreakpoint([]), []);
  });
});

describe('describeCacheUsage', () => {
  it('reports read and written cache tokens next to the totals', () => {
    const line = describeCacheUsage({
      inputTokens: 21000,
      outputTokens: 300,
      inputTokenDetails: { cacheReadTokens: 20000, cacheWriteTokens: 800 },
    });

    assert.equal(line, 'token usage: input=21000 cache_read=20000 cache_write=800 output=300');
  });

  it('prints zeros when the provider reports no usage', () => {
    assert.equal(describeCacheUsage(undefined), 'token usage: input=0 cache_read=0 cache_write=0 output=0');
  });
});

/**
 * The request the Anthropic provider builds from these helpers — the bytes
 * Anthropic sees decide whether anything is cached, not the helper's output.
 */
describe('Anthropic request body', () => {
  async function requestBodyFor({ system, messages }) {
    let body;
    const anthropic = createAnthropic({
      apiKey: 'test-key',
      fetch: async (_url, init) => {
        body = JSON.parse(init.body);
        return new Response(JSON.stringify({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-5',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    await generateText({ model: anthropic('claude-sonnet-5'), system, messages });
    return body;
  }

  it('sets a breakpoint on the system prompt and on the message that starts the turn', async () => {
    const body = await requestBodyFor({
      system: cachedSystemMessage('You are a helpful AI assistant.'),
      messages: withTurnBreakpoint([
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'answer' },
        { role: 'user', content: 'second' },
      ]),
    });

    assert.deepEqual(body.system, [
      { type: 'text', text: 'You are a helpful AI assistant.', cache_control: EPHEMERAL },
    ]);
    assert.equal(body.messages[0].content[0].cache_control, undefined);
    assert.equal(body.messages[1].content[0].cache_control, undefined);
    assert.deepEqual(body.messages[2].content[0].cache_control, EPHEMERAL);
    // No request-level cache_control: that would also write every tool round.
    assert.equal(body.cache_control, undefined);
  });
});
