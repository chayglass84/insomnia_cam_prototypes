import type { AiGatewayRunInfo, RequestTestResult, RunnerResultPerRequest } from 'insomnia-data';

import { RESPONSE_CODE_REASONS } from './constants';
import { formatUsd } from './llm-cost';
import { describeByteSize } from './misc';

export type RunnerItemStatus = 'pending' | 'running' | 'completed' | 'failed' | 'canceled' | 'skipped';

export interface RunnerLiveItem {
  key: string;
  iteration: number;
  requestId: string;
  /** Set once the request has been sent; the response saved in the request's history. */
  responseId?: string;
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

/** Sums token usage (and cost, where priced) across runner rows. Returns null when no row reported any usage. */
export const sumTokenUsage = (rows: { aiGateway?: AiGatewayRunInfo }[]) => {
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let hasUsage = false;
  let hasCost = false;
  for (const { aiGateway } of rows) {
    if (aiGateway && (aiGateway.inputTokens !== undefined || aiGateway.outputTokens !== undefined)) {
      hasUsage = true;
      inputTokens += aiGateway.inputTokens ?? 0;
      outputTokens += aiGateway.outputTokens ?? 0;
    }
    if (aiGateway?.costUsd !== undefined) {
      hasCost = true;
      costUsd += aiGateway.costUsd;
    }
  }
  return hasUsage ? { inputTokens, outputTokens, costUsd: hasCost ? costUsd : null } : null;
};

export const formatTokenUsage = ({ inputTokens, outputTokens }: { inputTokens?: number; outputTokens?: number }) =>
  `${(inputTokens ?? 0).toLocaleString()} in, ${(outputTokens ?? 0).toLocaleString()} out`;

/** `Cost: $0.0053`, or an empty string when there's no cost to show. */
export const formatCost = (costUsd: number | null | undefined) =>
  costUsd === null || costUsd === undefined ? '' : `Cost: ${formatUsd(costUsd)}`;

export interface ModelRunSummary {
  /** Stable id (route and alias, plus the model for a rotating alias); see `modelSummaryId`. */
  id: string;
  route: string;
  alias: string;
  model: string;
  /** The alias balances across several upstream models; this row is only the runs one of them answered. */
  rotating: boolean;
  inputTokens: number;
  outputTokens: number;
  /** Total USD for the model's runs, or null when none were priced. */
  costUsd: number | null;
  /** Runs the gateway declined (a configuration choice); they have no tests and are left out of the pass rate. */
  gatewayDeclined: number;
  passedTests: number;
  totalTests: number;
  /** Share of tests passed, 0-1, or null when the model's runs had no tests. */
  passRate: number | null;
}

/**
 * One row per model (route + alias, plus the actual model for rotating aliases), totalled across every request and iteration in the run, ranked:
 * highest test pass rate first, then cheapest, then fewest output tokens. Models with no tests rank after those with
 * tests, and models with no known cost rank after priced ones within the same pass rate. Skipped rows are ignored.
 * Keep the note in `RunnerModelSummary` in sync with this order.
 */
export const summarizeModelRuns = (rows: RunnerResultPerRequest[]): ModelRunSummary[] => {
  const byModel = new Map<string, ModelRunSummary>();
  for (const row of rows) {
    const info = row.aiGateway;
    if (!info || row.skipped) {
      continue;
    }
    // A rotating alias is split by the model that actually answered, since their cost and quality differ.
    const key = `${info.route ?? ''}\u0000${info.alias}\u0000${info.rotating ? info.model : ''}`;
    const summary = byModel.get(key) ?? {
      id: [info.route ?? '', info.alias, ...(info.rotating ? [info.model] : [])].join('|'),
      route: info.route ?? '',
      alias: info.alias,
      model: info.model,
      rotating: info.rotating === true,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: null,
      gatewayDeclined: 0,
      passedTests: 0,
      totalTests: 0,
      passRate: null,
    };
    // Rows that ran report the provider's actual (often dated) model; prefer that over the catalog name.
    summary.model = info.model || summary.model;
    summary.inputTokens += info.inputTokens ?? 0;
    summary.outputTokens += info.outputTokens ?? 0;
    if (info.costUsd !== undefined) {
      summary.costUsd = (summary.costUsd ?? 0) + info.costUsd;
    }
    if (info.gatewayNote) {
      summary.gatewayDeclined += 1;
    }
    summary.passedTests += (row.results ?? []).filter(result => result.status === 'passed').length;
    summary.totalTests += (row.results ?? []).length;
    byModel.set(key, summary);
  }
  const summaries = [...byModel.values()].map(summary => ({
    ...summary,
    passRate: summary.totalTests > 0 ? summary.passedTests / summary.totalTests : null,
  }));
  // Ascending-with-nulls-last / descending-with-nulls-last comparators for the two nullable keys.
  const nullsLast = (a: number | null, b: number | null, direction: 1 | -1) =>
    a === b ? 0 : a === null ? 1 : b === null ? -1 : direction * (a - b);
  return summaries.sort(
    (a, b) =>
      nullsLast(a.passRate, b.passRate, -1) || nullsLast(a.costUsd, b.costUsd, 1) || a.outputTokens - b.outputTokens,
  );
};

export interface ModelGroup<T> {
  /** Stable key for the group; empty for rows that didn't run against a gateway model. */
  key: string;
  info: AiGatewayRunInfo | null;
  /** The rows in this group with their position in the original list (for stable test ids). */
  entries: { row: T; index: number }[];
}

// Route + alias identify a model. The `model` string is NOT part of the key: a skipped row keeps the catalog name
// (`gpt-4.1-nano`) while a completed row carries the provider's dated one (`gpt-4.1-nano-2025-04-14`).
const modelKey = (info: AiGatewayRunInfo) => `${info.route ?? ''}\u0000${info.alias}`;

/**
 * Groups runner rows by the gateway model they ran against, in order of first appearance, so a run reads as
 * "model -> its requests". Rows without gateway info (a normal collection run) form one headingless group.
 */
export const groupRowsByModel = <T extends { aiGateway?: AiGatewayRunInfo }>(rows: T[]): ModelGroup<T>[] => {
  const groups = new Map<string, ModelGroup<T>>();
  rows.forEach((row, index) => {
    const key = row.aiGateway ? modelKey(row.aiGateway) : '';
    const group = groups.get(key) ?? { key, info: row.aiGateway ?? null, entries: [] };
    group.entries.push({ row, index });
    groups.set(key, group);
  });
  // Show the actual model from a row that ran (it has usage); skipped/pending rows only know the catalog name.
  return [...groups.values()].map(group => ({
    ...group,
    info:
      group.entries
        .map(entry => entry.row.aiGateway)
        .find(info => info && (info.inputTokens !== undefined || info.outputTokens !== undefined)) ?? group.info,
  }));
};

/** DOM id for a model's section within an iteration, so the summary table can scroll to it. */
export const modelAnchorId = (info: Pick<AiGatewayRunInfo, 'route' | 'alias'>, iteration: number) =>
  `runner-model-${iteration}-${`${info.route ?? ''}-${info.alias}`.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-')}`;
