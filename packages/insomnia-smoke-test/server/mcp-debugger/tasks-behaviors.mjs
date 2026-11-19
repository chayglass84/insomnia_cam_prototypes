// In-memory task store + payload builders for the mock MCP server's "tasks"
// extension. Factored out of mock-mcp-server.mjs (which calls server.listen()
// as a side effect on import) so tasks-schema-conformance.test.ts can import
// the exact payload-building logic without booting an http server.
//
// Poll-count-driven, not wall-clock-driven: each tasks/get advances a
// per-task counter so e2e lifecycles are deterministic (see
// TASKS_FIXTURE_PLAN.md).

const tasks = new Map();

const TASK_TOOLS = new Set([
  "quick-success-task",
  "input-required-task",
  "failed-task",
  "cancellable-task",
  "expired-task",
]);

export function isTaskTool(name) {
  return TASK_TOOLS.has(name);
}

let taskCounter = 0;

function nowIso() {
  return new Date().toISOString();
}

function baseFields(record) {
  return {
    taskId: record.taskId,
    createdAt: record.createdAt,
    lastUpdatedAt: nowIso(),
    ttlMs: null,
    pollIntervalMs: 10,
  };
}

/** `tools/call` reply for a task-returning tool: creates the task record and returns its handle. */
export function createTask(toolName) {
  taskCounter += 1;
  const taskId = `task-${taskCounter}`;
  const record = {
    taskId,
    behavior: toolName,
    status: "working",
    createdAt: nowIso(),
    getCount: 0,
  };
  tasks.set(taskId, record);
  return {
    ...baseFields(record),
    resultType: "task",
    status: "working",
  };
}

const INPUT_REQUEST_KEY = "confirmation";

function inputRequiredPayload() {
  return {
    [INPUT_REQUEST_KEY]: {
      method: "elicitation/create",
      params: {
        mode: "form",
        message: "Confirm to proceed",
        requestedSchema: {
          type: "object",
          properties: { proceed: { type: "string" } },
          required: ["proceed"],
        },
      },
    },
  };
}

/** Advance one `tasks/get` poll for a task, returning its current full-task payload, or null if unknown. */
export function getTask(taskId) {
  const record = tasks.get(taskId);
  if (!record) return null;
  record.getCount += 1;

  if (record.behavior === "quick-success-task") {
    if (record.getCount >= 2) {
      record.status = "completed";
      return {
        ...baseFields(record),
        status: "completed",
        result: { content: [{ type: "text", text: "quick task done" }], isError: false },
      };
    }
    return { ...baseFields(record), status: "working" };
  }

  if (record.behavior === "input-required-task") {
    if (record.status === "completed") {
      return {
        ...baseFields(record),
        status: "completed",
        result: { content: [{ type: "text", text: "input-required task done" }], isError: false },
      };
    }
    record.status = "input_required";
    return {
      ...baseFields(record),
      status: "input_required",
      inputRequests: inputRequiredPayload(),
    };
  }

  if (record.behavior === "failed-task") {
    if (record.getCount >= 2) {
      record.status = "failed";
      return {
        ...baseFields(record),
        status: "failed",
        error: { code: -32000, message: "task failed" },
      };
    }
    return { ...baseFields(record), status: "working" };
  }

  if (record.behavior === "cancellable-task") {
    return { ...baseFields(record), status: "working" };
  }

  if (record.behavior === "expired-task") {
    if (record.getCount >= 2) {
      // -32602 (Invalid params) is the spec's code for an invalid/nonexistent/expired
      // taskId on tasks/get (see taskPoller.ts's FATAL_TASK_ERROR_CODES) — not -32001,
      // which this codebase's MCP client already uses for an unrelated error
      // (stateless HeaderMismatch). Using the wrong code here means the client's
      // fatal-error detection never fires and the poller retries forever.
      return { dispatchError: { code: -32602, message: `task "${taskId}" has expired` } };
    }
    return { ...baseFields(record), status: "working" };
  }

  return { ...baseFields(record), status: record.status };
}

/** `tasks/update` handler: fulfills an input_required task's pending request, advancing it to completed. */
export function updateTask(taskId, params) {
  const record = tasks.get(taskId);
  if (!record) return null;
  if (record.behavior !== "input-required-task" || record.status !== "input_required") {
    return { ...baseFields(record), status: record.status };
  }
  if (!(INPUT_REQUEST_KEY in (params ?? {}))) {
    return {
      dispatchError: {
        code: -32602,
        message: `missing "${INPUT_REQUEST_KEY}" in tasks/update params`,
      },
    };
  }
  record.status = "completed";
  return {
    ...baseFields(record),
    status: "completed",
    result: { content: [{ type: "text", text: "input-required task done" }], isError: false },
  };
}

/** `tasks/cancel` handler: only "cancellable-task" ever leaves "working" via cancel in this fixture. */
export function cancelTask(taskId) {
  const record = tasks.get(taskId);
  if (!record) return null;
  record.status = "cancelled";
  return { ...baseFields(record), status: "cancelled" };
}

/** Test-only: reset all in-memory task state between test runs. */
export function resetTasksForTest() {
  tasks.clear();
  taskCounter = 0;
}
