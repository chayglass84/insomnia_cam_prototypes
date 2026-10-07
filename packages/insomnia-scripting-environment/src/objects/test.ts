import type { RequestTestResult } from 'insomnia-data';

const NativePromise = Promise;

/** @ignore */
export async function test(msg: string, fn: () => Promise<void | string>, log: (testResult: RequestTestResult) => void) {
  const wrapFn = async () => {
    const started = performance.now();

    try {
      const detail = await fn();

      const executionTime = performance.now() - started;
      log({
        testCase: msg,
        status: 'passed',
        executionTime,
        // A test may return a string to show alongside its result.
        ...(typeof detail === 'string' && detail ? { detail } : {}),
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
export async function skip(msg: string, _: () => Promise<void | string>, log: (testResult: RequestTestResult) => void) {
  log({
    testCase: msg,
    status: 'skipped',
    executionTime: 0,
    category: 'unknown',
  });
}

/** ignore */
export interface TestHandler {
  (msg: string, fn: () => Promise<void | string>): Promise<void>;
  skip?: (msg: string, fn: () => Promise<void | string>) => void;
}
