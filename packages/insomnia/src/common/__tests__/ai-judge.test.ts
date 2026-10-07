import { describe, expect, it } from 'vitest';

import { DEFAULT_JUDGE_INSTRUCTIONS, resolveJudgeInstructions } from '../ai-judge';

describe('resolveJudgeInstructions', () => {
  it('falls back to the default when nothing was saved', () => {
    expect(resolveJudgeInstructions()).toBe(DEFAULT_JUDGE_INSTRUCTIONS.trim());
    expect(resolveJudgeInstructions(null)).toBe(DEFAULT_JUDGE_INSTRUCTIONS.trim());
  });

  it('uses what the user saved, trimmed', () => {
    expect(resolveJudgeInstructions('  Be kind.  ')).toBe('Be kind.');
  });

  it('treats an explicitly empty string as no extra instructions', () => {
    expect(resolveJudgeInstructions('')).toBe('');
  });
});
