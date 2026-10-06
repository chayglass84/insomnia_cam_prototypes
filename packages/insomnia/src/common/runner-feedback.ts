import type { AiGatewayRunInfo, RequestTestResult, RunnerResultPerRequest } from 'insomnia-data';

import { RESPONSE_CODE_REASONS } from './constants';
import { describeByteSize } from './misc';

export type RunnerItemStatus = 'pending' | 'running' | 'completed' | 'failed' | 'canceled' | 'skipped';

export interface RunnerLiveItem {
  key: string;
  iteration: number;
  requestId: string;
  requestName: string;
  requestUrl: string;
  status: RunnerItemStatus;
  statusCode?: number;
  statusMessage?: string;
  responseTime?: number;
  responseSize?: number;
  errorMessage?: string;
  results?: RequestTestResult[];
  aiGateway?: AiGatewayRunInfo;
}

export const buildRunnerItemKey = (iteration: number, index: number, requestId: string) =>
  `${iteration}-${index}-${requestId}`;

export const formatStatusLabel = (item: { statusCode?: number; statusMessage?: string }) => {
  if (item.statusCode && item.statusCode > 0) {
    const reason = item.statusMessage || RESPONSE_CODE_REASONS[item.statusCode] || '';
    return reason ? `${item.statusCode} ${reason}` : `${item.statusCode}`;
  }
  return item.statusMessage || '';
};

export const formatResponseStats = ({ responseTime, responseSize }: { responseTime?: number; responseSize?: number }) =>
  [
    typeof responseTime === 'number' && responseTime >= 0 ? `${Math.round(responseTime)}ms` : null,
    typeof responseSize === 'number' && responseSize >= 0 ? describeByteSize(responseSize, true) : null,
  ]
    .filter(Boolean)
    .join(' - ');

const STATUS_TAGS: Partial<Record<RunnerItemStatus, { label: string; className: string }>> = {
  pending: { label: 'PENDING', className: 'bg-slate-600' },
  running: { label: 'RUNNING', className: 'bg-sky-600' },
  canceled: { label: 'CANCELED', className: 'bg-slate-600' },
  skipped: { label: 'SKIPPED', className: 'bg-slate-600' },
};

export const getRunnerStatusTag = (item: { status: RunnerItemStatus; statusCode?: number; statusMessage?: string }) => {
  const fixed = STATUS_TAGS[item.status];
  if (fixed) {
    return fixed;
  }
  const label = formatStatusLabel(item);
  if (!label) {
    return { label: 'ERROR', className: 'bg-red-600' };
  }
  const code = item.statusCode ?? 0;
  const className =
    code >= 200 && code < 300 ? 'bg-lime-600' : code >= 300 && code < 400 ? 'bg-yellow-600' : 'bg-red-600';
  return { label, className };
};

export const isFinished = (status: RunnerItemStatus) =>
  status === 'completed' || status === 'failed' || status === 'canceled' || status === 'skipped';

/** Sums token usage across runner rows. Returns null when no row reported any usage. */
export const sumTokenUsage = (rows: { aiGateway?: AiGatewayRunInfo }[]) => {
  let inputTokens = 0;
  let outputTokens = 0;
  let hasUsage = false;
  for (const { aiGateway } of rows) {
    if (aiGateway && (aiGateway.inputTokens !== undefined || aiGateway.outputTokens !== undefined)) {
      hasUsage = true;
      inputTokens += aiGateway.inputTokens ?? 0;
      outputTokens += aiGateway.outputTokens ?? 0;
    }
  }
  return hasUsage ? { inputTokens, outputTokens } : null;
};

export const formatTokenUsage = ({ inputTokens, outputTokens }: { inputTokens?: number; outputTokens?: number }) =>
  `${(inputTokens ?? 0).toLocaleString()} in, ${(outputTokens ?? 0).toLocaleString()} out`;

export interface ModelRunSummary {
  route: string;
  alias: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  passedTests: number;
  totalTests: number;
  /** Share of tests passed, 0-1, or null when the model's runs had no tests. */
  passRate: number | null;
}

/**
 * One row per model (route + alias + actual model), totalled across every request and iteration in the run, ranked:
 * highest test pass rate first, then fewest output tokens. Models whose runs had no tests rank after those that did.
 * Skipped rows are ignored.
 */
export const summarizeModelRuns = (rows: RunnerResultPerRequest[]): ModelRunSummary[] => {
  const byModel = new Map<string, ModelRunSummary>();
  for (const row of rows) {
    const info = row.aiGateway;
    if (!info || row.skipped) {
      continue;
    }
    const key = `${info.route ?? ''}\u0000${info.alias}\u0000${info.model}`;
    const summary = byModel.get(key) ?? {
      route: info.route ?? '',
      alias: info.alias,
      model: info.model,
      inputTokens: 0,
      outputTokens: 0,
      passedTests: 0,
      totalTests: 0,
      passRate: null,
    };
    summary.inputTokens += info.inputTokens ?? 0;
    summary.outputTokens += info.outputTokens ?? 0;
    summary.passedTests += (row.results ?? []).filter(result => result.status === 'passed').length;
    summary.totalTests += (row.results ?? []).length;
    byModel.set(key, summary);
  }
  const summaries = [...byModel.values()].map(summary => ({
    ...summary,
    passRate: summary.totalTests > 0 ? summary.passedTests / summary.totalTests : null,
  }));
  return summaries.sort((a, b) => {
    if (a.passRate !== b.passRate) {
      if (a.passRate === null) {
        return 1;
      }
      if (b.passRate === null) {
        return -1;
      }
      return b.passRate - a.passRate;
    }
    return a.outputTokens - b.outputTokens;
  });
};
