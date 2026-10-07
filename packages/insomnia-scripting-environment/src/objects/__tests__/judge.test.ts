import { describe, expect, it } from 'vitest';

import {
  buildJudgeRequestBody,
  extractAnswerText,
  extractQuestionText,
  type JudgeSend,
  parseJudgeReply,
  runJudge,
} from '../judge';

const options = { url: 'http://gw/judge/chat/completions', model: 'mini' };
const criteria = ['five bullets', 'concise'];
const openAiReply = (content: string) => JSON.stringify({ choices: [{ message: { content } }] });
const sendWith =
  (code: number, text: string): JudgeSend =>
  async () => ({ code, text });

describe('extractAnswerText', () => {
  it('reads Anthropic content blocks, ignoring non-text blocks', () => {
    const body = {
      content: [
        { type: 'thinking', thinking: 'hmm' },
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ],
    };
    expect(extractAnswerText(body)).toBe('ab');
  });

  it('reads OpenAI choices', () => {
    expect(extractAnswerText({ choices: [{ message: { content: 'hi' } }] })).toBe('hi');
  });

  it('returns an empty string for anything else', () => {
    expect(extractAnswerText(null)).toBe('');
    expect(extractAnswerText({ error: 'nope' })).toBe('');
  });
});

describe('extractQuestionText', () => {
  it('returns the last user message', () => {
    const body = JSON.stringify({
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'mid' },
        { role: 'user', content: [{ type: 'text', text: 'second' }] },
      ],
    });
    expect(extractQuestionText(body)).toBe('second');
  });

  it('is empty for a non-chat or unparseable body', () => {
    expect(extractQuestionText('not json')).toBe('');
    expect(extractQuestionText(JSON.stringify({ prompt: 'x' }))).toBe('');
    expect(extractQuestionText()).toBe('');
  });
});

describe('buildJudgeRequestBody', () => {
  it('numbers the criteria, includes question and answer, and turns streaming off', () => {
    const body = JSON.parse(buildJudgeRequestBody({ question: 'Q?', answer: 'A.', criteria, options }));
    expect(body.model).toBe('mini');
    expect(body.stream).toBe(false);
    expect(body.messages[1].content).toContain('Q?');
    expect(body.messages[1].content).toContain('A.');
    expect(body.messages[1].content).toContain('1. five bullets\n2. concise');
  });

  it('keeps the template body (model, params) and forces streaming off, dropping stream_options', () => {
    const body = JSON.parse(
      buildJudgeRequestBody({
        question: '',
        answer: 'A',
        criteria,
        options: {
          url: options.url,
          body: {
            model: 'tmpl',
            temperature: 0,
            stream: true,
            stream_options: { include_usage: true },
            messages: [{ role: 'user', content: 'old' }],
          },
        },
      }),
    );
    expect(body.model).toBe('tmpl');
    expect(body.temperature).toBe(0);
    expect(body.stream).toBe(false);
    expect(body).not.toHaveProperty('stream_options');
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe('system');
  });

  it('lets options.model override the template model', () => {
    const body = JSON.parse(
      buildJudgeRequestBody({
        question: '',
        answer: 'A',
        criteria,
        options: { url: options.url, model: 'x', body: { model: 'tmpl' } },
      }),
    );
    expect(body.model).toBe('x');
  });

  it('builds an Anthropic body (top-level system, max_tokens) for a /messages url or a template with system', () => {
    const byUrl = JSON.parse(
      buildJudgeRequestBody({
        question: 'Q',
        answer: 'A',
        criteria,
        options: { url: 'http://gw/anthropic/v1/messages', model: 'opus' },
      }),
    );
    expect(byUrl.max_tokens).toBe(1024);
    expect(byUrl.system).toContain('Reply with JSON only');
    expect(byUrl.messages).toEqual([{ role: 'user', content: expect.stringContaining('1. five bullets') }]);

    const byTemplate = JSON.parse(
      buildJudgeRequestBody({
        question: '',
        answer: 'A',
        criteria,
        options: { url: 'http://gw/x', body: { model: 'm', max_tokens: 4096, system: 'old' } },
      }),
    );
    expect(byTemplate.max_tokens).toBe(4096);
    expect(byTemplate.system).toContain('Reply with JSON only');
    expect(byTemplate.messages).toHaveLength(1);
  });

  it('throws when there is no model anywhere', () => {
    expect(() => buildJudgeRequestBody({ question: '', answer: 'A', criteria, options: { url: options.url } })).toThrow(
      /no model/,
    );
  });

  it('appends user instructions to, never replaces, the built-in prompt', () => {
    const body = JSON.parse(
      buildJudgeRequestBody({ question: '', answer: 'A', criteria, options: { ...options, system: 'Be harsh.' } }),
    );
    expect(body.messages[0].content).toContain('Reply with JSON only');
    expect(body.messages[0].content).toContain('Be harsh.');
  });
});

describe('parseJudgeReply', () => {
  it('parses a clean reply', () => {
    const verdict = parseJudgeReply(
      '{"checks":[{"criterion":"x","pass":true},{"criterion":"y","pass":false}],"reason":"meh"}',
      criteria,
    );
    expect(verdict.passed).toBe(1);
    expect(verdict.total).toBe(2);
    expect(verdict.allPassed).toBe(false);
    expect(verdict.reason).toBe('meh');
    expect(verdict.summary).toBe('✓ five bullets\n✗ concise\nJudge: meh');
  });

  it('tolerates code fences and surrounding prose', () => {
    const verdict = parseJudgeReply(
      'Sure!\n```json\n{"checks":[{"pass":true},{"pass":true}],"reason":"ok"}\n```',
      criteria,
    );
    expect(verdict.allPassed).toBe(true);
  });

  it('counts a criterion the judge skipped, or answered with a non-boolean, as failed', () => {
    const verdict = parseJudgeReply('{"checks":[{"pass":true},{"pass":"yes"}],"reason":""}', criteria);
    expect(verdict.checks.map(c => c.pass)).toEqual([true, false]);
    const short = parseJudgeReply('{"checks":[{"pass":true}]}', criteria);
    expect(short.checks.map(c => c.pass)).toEqual([true, false]);
    expect(short.allPassed).toBe(false);
  });

  it('throws with the raw reply when there is no JSON', () => {
    expect(() => parseJudgeReply('I cannot do that', criteria)).toThrow(/not JSON: I cannot do that/);
  });
});

describe('runJudge', () => {
  const base = { criteria, options, answer: 'an answer', question: 'a question' };

  it('returns a verdict for a good reply and sends the built body to the judge url', async () => {
    let sent: { url: string; body: string } | undefined;
    const send: JudgeSend = async (url, _headers, body) => {
      sent = { url, body };
      return { code: 200, text: openAiReply('{"checks":[{"pass":true},{"pass":false}],"reason":"r"}') };
    };
    const verdict = await runJudge({ ...base, send });
    expect(verdict.passed).toBe(1);
    expect(sent?.url).toBe(options.url);
    expect(sent?.body).toContain('an answer');
  });

  it('throws the gateway status, url and body on a non-200', async () => {
    await expect(runJudge({ ...base, send: sendWith(404, '{"message":"no Route matched"}') })).rejects.toThrow(
      /judge 404 from "http:\/\/gw\/judge\/chat\/completions": .*no Route matched/,
    );
  });

  it('rejects bad input before sending anything', async () => {
    const send: JudgeSend = async () => {
      throw new Error('should not be called');
    };
    await expect(runJudge({ ...base, criteria: [], send })).rejects.toThrow(/at least one criterion/);
    await expect(runJudge({ ...base, options: { model: 'm' }, send })).rejects.toThrow(/no judge is configured/);
    await expect(runJudge({ ...base, answer: '', send })).rejects.toThrow(/no answer text/);
  });

  it('throws when the judge answers with prose instead of JSON', async () => {
    await expect(runJudge({ ...base, send: sendWith(200, openAiReply('Looks fine to me')) })).rejects.toThrow(
      /not JSON/,
    );
  });
});
