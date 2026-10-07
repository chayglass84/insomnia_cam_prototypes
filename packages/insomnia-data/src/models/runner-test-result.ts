import type { BaseModel } from './base-types';

export const name = 'Runner Test Result';

export const type = 'RunnerTestResult';

export const prefix = 'rtr';

export const canDuplicate = false;

export const canSync = false;

export type TestStatus = 'passed' | 'failed' | 'skipped';
export type TestCategory = 'unknown' | 'pre-request' | 'after-response';

export interface RequestTestResult {
  testCase: string;
  status: TestStatus;
  executionTime: number; // milliseconds
  errorMessage?: string;
  /** Prototype (3593AI): free text a test returns from its callback (e.g. an LLM judge's reasoning), shown under the test name. */
  detail?: string;
  /** Prototype (3593AI): how many of an LLM judge's checks passed, recorded when a test returns an `insomnia.judge()` verdict. */
  checks?: { passed: number; total: number };
  category: TestCategory;
}

/** Prototype (3593AI): which gateway model a runner row ran against, and what it used. */
export interface AiGatewayRunInfo {
  /** The route (path) this model is served on, e.g. `/anthropic`. */
  route?: string;
  /** The route's model value from the request body, e.g. `opus`. */
  alias: string;
  /** The actual model, as reported by the provider response when available, else the catalog target. */
  model: string;
  /** True when the alias balances across several upstream models, so `model` is only known once a response arrives. */
  rotating?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  /** Set when the gateway rejected a request whose format differs from the target model's: a gateway configuration choice, not a failure. */
  gatewayNote?: string;
  /** USD for this run, from the model's Konnect price at send time. Absent when no price is known. */
  costUsd?: number;
}

export interface RunnerResultPerRequest {
  /** Prototype (3593AI): lets a result row jump to the response it came from. Absent on older runs. */
  requestId?: string;
  responseId?: string;
  results: RequestTestResult[];
  requestName: string;
  requestUrl: string;
  responseCode: number;
  responseMessage?: string;
  responseTime?: number;
  responseSize?: number;
  skipped?: boolean;
  aiGateway?: AiGatewayRunInfo;
}

/** Prototype (3593AI): a model's score from the collection's Model Scoring script, frozen with the run. */
export interface ModelScore {
  /** Matches `ModelRunSummary.id`: route and alias (plus the model for a rotating alias). */
  id: string;
  score: number;
  note?: string;
}

export interface ResponseInfo {
  responseId: string;
  originalRequestName: string;
  originalRequestId: string;
}

export type RunnerResultPerRequestPerIteration = RunnerResultPerRequest[][];

export interface BaseRunnerTestResult {
  source: 'runner';
  iterations: number;
  duration: number; // millisecond
  avgRespTime: number; // millisecond
  iterationResults: RunnerResultPerRequestPerIteration;
  responsesInfo: ResponseInfo[];
  /** Prototype (3593AI): scores computed when the run finished, and why scoring failed if it did. */
  modelScores?: ModelScore[];
  scoringError?: string;
  version: '1'; // We might want to add or remove result features in future
}

export type RunnerTestResult = BaseModel & BaseRunnerTestResult;

// Not in init(), and the data layer prunes top-level fields a model does not declare, so these must be listed here.
export const optionalKeys = ['modelScores', 'scoringError'];

export const isRunnerTestResult = (model: Pick<BaseModel, 'type'>): model is RunnerTestResult => model.type === type;

export function init() {
  return {
    source: 'runner',
    iterations: 0,
    duration: 0,
    avgRespTime: 0,
    iterationResults: [],
    responsesInfo: [],
    version: '1',
  };
}
