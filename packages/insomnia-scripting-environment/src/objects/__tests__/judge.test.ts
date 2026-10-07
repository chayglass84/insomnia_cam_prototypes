import { describe, expect, it } from 'vitest';

import {
  buildJudgeRequestBody,
  combineJudgeReplies,
  extractAnswerText,
  extractQuestionText,
  type JudgeSend,
  MAX_JUDGE_RUNS,
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
  it('reads a score per criterion and the reason', () => {
    const reply = parseJudgeReply('{"checks":[{"score":1},{"score":0.5}],"reason":"meh"}', criteria);
    expect(reply.scores).toEqual([1, 0.5]);
    expect(reply.reason).toBe('meh');
  });

  it('snaps any other number to the nearest of 0, 0.5 and 1, and clamps', () => {
    const reply = parseJudgeReply('{"checks":[{"score":0.8},{"score":0.2}]}', criteria);
    expect(reply.scores).toEqual([1, 0]);
    expect(parseJudgeReply('{"checks":[{"score":7},{"score":-3}]}', criteria).scores).toEqual([1, 0]);
    expect(parseJudgeReply('{"checks":[{"score":0.6},{"score":0.4}]}', criteria).scores).toEqual([0.5, 0.5]);
  });

  it('still understands a legacy pass boolean', () => {
    expect(parseJudgeReply('{"checks":[{"pass":true},{"pass":false}]}', criteria).scores).toEqual([1, 0]);
  });

  it('tolerates code fences and surrounding prose', () => {
    const reply = parseJudgeReply('Sure!\n```json\n{"checks":[{"score":1},{"score":1}],"reason":"ok"}\n```', criteria);
    expect(reply.scores).toEqual([1, 1]);
  });

  it('scores a skipped or malformed criterion 0, never a pass', () => {
    expect(parseJudgeReply('{"checks":[{"score":1},{"score":"yes"}]}', criteria).scores).toEqual([1, 0]);
    expect(parseJudgeReply('{"checks":[{"score":1}]}', criteria).scores).toEqual([1, 0]);
    expect(parseJudgeReply('{"checks":[null,{"pass":"true"}]}', criteria).scores).toEqual([0, 0]);
  });

  it('throws with the raw reply when there is no JSON', () => {
    expect(() => parseJudgeReply('I cannot do that', criteria)).toThrow(/not JSON: I cannot do that/);
  });
});

describe('combineJudgeReplies', () => {
  const reply = (scores: number[], reason = '') => ({ scores, reason, raw: JSON.stringify({ scores }) });

  it('with one run, a criterion passes only at 1 and partial credit counts toward the score', () => {
    const verdict = combineJudgeReplies(criteria, [reply([1, 0.5], 'close')]);
    expect(verdict.checks.map(check => check.pass)).toEqual([true, false]);
    expect(verdict.passed).toBe(1);
    expect(verdict.score).toBe(1.5);
    expect(verdict.allPassed).toBe(false);
    expect(verdict.summary).toBe('✓ five bullets\n◐ concise — score 0.5\n\nJudge: close');
  });

  it('averages the runs per criterion: 0.5 and 1 make 0.75, which is not a pass', () => {
    const verdict = combineJudgeReplies(criteria, [reply([1, 0.5], 'a'), reply([1, 1], 'b')]);
    expect(verdict.checks[1]).toMatchObject({ score: 0.75, pass: false, runs: [0.5, 1] });
    expect(verdict.checks[0]).toMatchObject({ score: 1, pass: true, runs: [1, 1] });
    expect(verdict.score).toBe(1.75);
    expect(verdict.runCount).toBe(2);
  });

  it('shows every run next to the average, so the mean stays inspectable', () => {
    const verdict = combineJudgeReplies(criteria, [reply([1, 0], 'x'), reply([0, 0], 'y')]);
    expect(verdict.summary).toContain('◐ five bullets — average score 0.5 (runs: 1, 0)');
    expect(verdict.summary).toContain('✗ concise — average score 0 (runs: 0, 0)');
    // All the results first, then a blank line, then each run's answer (without the word "Judge").
    expect(verdict.summary).toContain('(runs: 0, 0)\n\nRun 1: x\nRun 2: y');
    expect(verdict.summary).not.toContain('Judge:');
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

  it('expectAllPassed passes silently, and throws with the verdict attached when a check failed', async () => {
    const good = await runJudge({
      ...base,
      send: sendWith(200, openAiReply('{"checks":[{"pass":true},{"pass":true}],"reason":"ok"}')),
    });
    expect(() => good.expectAllPassed()).not.toThrow();

    const bad = await runJudge({
      ...base,
      send: sendWith(200, openAiReply('{"checks":[{"pass":true},{"pass":false}],"reason":"meh"}')),
    });
    let thrown: any;
    try {
      bad.expectAllPassed();
    } catch (error) {
      thrown = error;
    }
    expect(thrown.message).toContain('✗ concise');
    expect(thrown.judgeVerdict).toMatchObject({ passed: 1, total: 2, control: false });
  });

  it('marks a verdict as a control when it graded fixed text', async () => {
    const verdict = await runJudge({
      ...base,
      control: true,
      send: sendWith(200, openAiReply('{"checks":[{"pass":true},{"pass":true}],"reason":""}')),
    });
    expect(verdict.control).toBe(true);
  });

  it('asks the judge `runs` times, all at once, and averages them', async () => {
    const replies = ['{"checks":[{"score":1},{"score":0.5}]}', '{"checks":[{"score":1},{"score":1}]}'];
    let calls = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const send: JudgeSend = async () => {
      const mine = calls++;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, 5));
      inFlight--;
      return { code: 200, text: openAiReply(replies[mine]) };
    };
    const verdict = await runJudge({ ...base, options: { ...options, runs: 2 }, send });
    expect(calls).toBe(2);
    expect(maxInFlight).toBe(2);
    expect(verdict.checks[1].score).toBe(0.75);
    expect(verdict.runCount).toBe(2);
  });

  it('keeps runs between 1 and the cap, and treats nonsense as 1', async () => {
    const counts: number[] = [];
    for (const runs of [0, -4, Number.NaN, 2.9, 999]) {
      let calls = 0;
      await runJudge({
        ...base,
        options: { ...options, runs },
        send: async () => {
          calls++;
          return { code: 200, text: openAiReply('{"checks":[{"score":1},{"score":1}]}') };
        },
      });
      counts.push(calls);
    }
    expect(counts).toEqual([1, 1, 1, 2, MAX_JUDGE_RUNS]);
  });

  it('fails if any run fails', async () => {
    let call = 0;
    const send: JudgeSend = async () => ({
      code: call++ === 0 ? 200 : 500,
      text: call === 1 ? openAiReply('{"checks":[{"score":1},{"score":1}]}') : 'boom',
    });
    await expect(runJudge({ ...base, options: { ...options, runs: 2 }, send })).rejects.toThrow(/judge 500/);
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
