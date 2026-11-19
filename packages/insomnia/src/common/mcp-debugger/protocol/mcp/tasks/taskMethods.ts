import type { Invocation } from "../../Protocol";

/**
 * Wire methods for the 2026-07-28 RC "tasks" extension.
 */
export const TASKS_GET = "tasks/get";
export const TASKS_CANCEL = "tasks/cancel";
export const TASKS_UPDATE = "tasks/update";

/**
 * `tasks/get` — fetch the full Task (plus an `inputRequests` map when the task
 * is `input_required`). `taskId` is the top-level param and the source of
 * truth for this method; unlike a task-scoped request that carries a task, this
 * one does NOT carry `_meta`'s `io.modelcontextprotocol/related-task`.
 */
export function buildTasksGet(taskId: string): Invocation {
  return { method: TASKS_GET, params: { taskId } };
}

/**
 * `tasks/cancel` — request cancellation of a task. Returns the updated Task (or
 * an empty ack). Same top-level-`taskId` rule as `tasks/get`.
 */
export function buildTasksCancel(taskId: string): Invocation {
  return { method: TASKS_CANCEL, params: { taskId } };
}

/**
 * `tasks/update` — fulfill one or more pending `input_required` requests
 * (transitions the task back to `working`) and/or revise its `ttl`. Both
 * `opts.ttl` and `opts.inputs` are optional and independent; omit either to
 * leave that aspect unchanged. `taskId` is the top-level param and the source
 * of truth here too — no `related-task` `_meta`.
 *
 * `opts.inputs` is spread alongside `taskId`/`ttl` because the RC drafts don't
 * agree on (or even specify) a nesting key for input fulfillments — inventing
 * one here would be a guess this codebase can't verify (elicitation UI is out
 * of scope; T4 owns it). Rather than silently let a fulfillment key collide
 * with and clobber `taskId`/`ttl`, this throws — fail loud, don't corrupt the
 * request.
 */
export function buildTasksUpdate(
  taskId: string,
  opts?: { ttl?: number; inputs?: Record<string, unknown> },
): Invocation {
  const inputs = opts?.inputs;
  if (inputs && ("taskId" in inputs || "ttl" in inputs)) {
    throw new Error(
      `tasks/update input fulfillment key collides with a reserved param name ("taskId"/"ttl")`,
    );
  }
  return {
    method: TASKS_UPDATE,
    params: {
      taskId,
      ...(opts?.ttl != null ? { ttl: opts.ttl } : {}),
      ...(inputs ? inputs : {}),
    },
  };
}
