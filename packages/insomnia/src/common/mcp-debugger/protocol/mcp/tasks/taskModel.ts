/**
 * Wire-shaped task model for the 2026-07-28 RC "tasks" extension. A `tools/call`
 * may return a task handle instead of a terminal result when the server needs
 * to keep working past the request; this module normalizes that handle (and
 * the `tasks/get` et al. full-task reply) into one internal shape so callers
 * never branch on the wire shape (task handle vs. full-task reply).
 */

/**
 * Status enum, exact wire strings. `working` and `input_required` are
 * non-terminal (either may transition to the other, or to any terminal
 * status); `completed` | `failed` | `cancelled` are terminal and frozen — a
 * task never transitions out of one once reached.
 */
export type TaskStatus = "working" | "input_required" | TerminalTaskStatus;

/** The frozen statuses — once reached, a task record is never updated past them. */
export type TerminalTaskStatus = "completed" | "failed" | "cancelled";

export const TASK_TERMINAL_STATUSES: ReadonlySet<TerminalTaskStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

export function isTaskTerminal(status: TaskStatus): status is TerminalTaskStatus {
  return (TASK_TERMINAL_STATUSES as ReadonlySet<TaskStatus>).has(status);
}

/**
 * Internal, normalized task shape. Wire-only fields — connection-scoping
 * (connectionId/session) and the trace correlationId that created it are added
 * by `useTaskStore`, not here, so this type stays the same whether it came off
 * a `tools/call` task handle or a `tasks/get` reply.
 */
export interface TaskRecord {
  taskId: string;
  status: TaskStatus;
  statusMessage?: string;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601. */
  lastUpdatedAt: string;
  /** `null`/`undefined` when the server omitted it. */
  ttlMs?: number | null;
  pollIntervalMs?: number;
  /** Present on a `tasks/get` reply when `status === "input_required"`. */
  inputRequests?: Record<string, unknown>;
}

/** The exact `TaskStatus` wire strings, used to validate `status` rather than trust it blindly. */
const TASK_STATUSES: ReadonlySet<string> = new Set([
  "working",
  "input_required",
  "completed",
  "failed",
  "cancelled",
]);

/**
 * True when `result` is a `tools/call` reply carrying a task handle rather than
 * a terminal result. `CreateTaskResult` carries `resultType: "task"` as a
 * discriminator field; `Task`/`GetTaskResult` variants (returned by `tasks/get`
 * et al.) do NOT carry `resultType`. Detection for these variants is structural
 *  — a string `taskId` plus a valid `status`. A present-but-wrong `resultType`
 * string is rejected as a defensive guard (see `parseTaskHandle`).
 */
export function isTaskResult(result: unknown): boolean {
  return parseTaskHandle(result) !== null;
}

/**
 * Normalize a task-handle result (`tools/call`'s `CreateTaskResult`) or a bare
 * `tasks/get`/`tasks/cancel`/`tasks/update` `GetTaskResult` reply into a
 * `TaskRecord`. `CreateTaskResult` carries `resultType: "task"`;
 * `Task`/`GetTaskResult` variants carry no `resultType`. Detection for these
 * variants is structural — a string `taskId` plus a valid `status`. Defensive guard:
 * if `resultType` is present as a string AND is not `"task"`, the payload is not a
 * task handle and `null` is returned. If `resultType` is absent the check is
 * skipped so `GetTaskResult` falls through to the structural check unchanged.
 * Returns `null` when no string `taskId` is present, or when `status` is
 * missing/invalid.
 */
export function parseTaskHandle(result: unknown): TaskRecord | null {
  if (result === null || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;

  // Defensive guard: a payload that explicitly tags itself with a resultType
  // other than "task" is not a task handle, even if it has taskId+status.
  if (typeof r.resultType === "string" && r.resultType !== "task") return null;

  const taskId = r.taskId;
  if (typeof taskId !== "string") return null;

  const rawStatus = r.status;
  const status =
    typeof rawStatus === "string" && TASK_STATUSES.has(rawStatus) ? rawStatus : undefined;
  if (status === undefined) return null;

  const createdAt = r.createdAt;
  const lastUpdatedAt = r.lastUpdatedAt;
  const ttl = r.ttlMs;
  const pollInterval = r.pollIntervalMs;
  const inputRequests = r.inputRequests;

  return {
    taskId,
    status: status as TaskStatus,
    ...(typeof r.statusMessage === "string" ? { statusMessage: r.statusMessage } : {}),
    createdAt: typeof createdAt === "string" ? createdAt : "",
    lastUpdatedAt: typeof lastUpdatedAt === "string" ? lastUpdatedAt : "",
    ...(typeof ttl === "number" || ttl === null ? { ttlMs: ttl } : {}),
    ...(typeof pollInterval === "number" ? { pollIntervalMs: pollInterval } : {}),
    ...(inputRequests !== null && typeof inputRequests === "object" ? { inputRequests } : {}),
  } as TaskRecord;
}
