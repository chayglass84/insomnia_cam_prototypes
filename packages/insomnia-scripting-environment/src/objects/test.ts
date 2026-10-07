import type { RequestTestResult } from 'insomnia-data';

import type { JudgeVerdict } from './judge';

const NativePromise = Promise;

type TestReturn = void | string | JudgeVerdict;

interface VerdictLike {
  summary: string;
  passed: number;
  total: number;
  /** Partial credit when the judge ran with partial scores (and possibly several runs); falls back to `passed`. */
  score?: number;
  control?: boolean;
}

const isVerdictLike = (value: unknown): value is VerdictLike =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as VerdictLike).summary === 'string' &&
  Number.isFinite((value as VerdictLike).passed) &&
  Number.isFinite((value as VerdictLike).total);

/**
 * What a test hands back: a string is shown under the test name, and an `insomnia.judge()` verdict shows its summary and
 * records how many checks passed, so scoring can use it. A control (graded fixed text, not the response) is not recorded.
 */
const describeReturn = (value: unknown): Pick<RequestTestResult, 'detail' | 'checks'> => {
  if (typeof value === 'string') {
    return value ? { detail: value } : {};
  }
  if (isVerdictLike(value)) {
    return {
      ...(value.summary ? { detail: value.summary } : {}),
      ...(value.control
        ? {}
        : {
            checks: {
              passed: Number.isFinite(value.score) ? (value.score as number) : value.passed,
              total: value.total,
            },
          }),
    };
  }
  return {};
};

/** @ignore */
export async function test(msg: string, fn: () => Promise<TestReturn>, log: (testResult: RequestTestResult) => void) {
  const wrapFn = async () => {
    const started = performance.now();

    try {
      const returned = await fn();

      const executionTime = performance.now() - started;
      log({
        testCase: msg,
        status: 'passed',
        executionTime,
        // A test may return a string or a judge verdict to show alongside its result.
        ...describeReturn(returned),
        category: 'unknown',
      });
    } catch (e) {
      const executionTime = performance.now() - started;
      log({
        testCase: msg,
        status: 'failed',
        executionTime,
        // ACTUAL/EXPECTED only exist on assertion errors; a thrown Error would just print "undefined" for both.
        errorMessage:
          e.actual === undefined && e.expected === undefined
            ? `error: ${e}`
            : `error: ${e} | ACTUAL: ${e.actual} | EXPECTED: ${e.expected}`,
        // `verdict.expectAllPassed()` throws with the verdict attached, so a failed judge still records its checks.
        ...('checks' in describeReturn(e.judgeVerdict) ? { checks: describeReturn(e.judgeVerdict).checks } : {}),
        category: 'unknown',
      });
    }
  };

  const testPromise = wrapFn();
  startTestObserver(testPromise);
  return testPromise;
}

let testPromises = new Array<Promise<void>>();

/** @ignore */
export function resetTestPromises() {
  testPromises = [];
}

/** ignore */
export async function waitForAllTestsDone() {
  await NativePromise.allSettled(testPromises);
  testPromises = [];
}
function startTestObserver(promise: Promise<void>) {
  testPromises.push(promise);
}

/** ignore */
export async function skip(msg: string, _: () => Promise<TestReturn>, log: (testResult: RequestTestResult) => void) {
  log({
    testCase: msg,
    status: 'skipped',
    executionTime: 0,
    category: 'unknown',
  });
}

/** ignore */
export interface TestHandler {
  (msg: string, fn: () => Promise<TestReturn>): Promise<void>;
  skip?: (msg: string, fn: () => Promise<TestReturn>) => void;
}
