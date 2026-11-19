import React, { type FC } from 'react';
import { Button } from 'react-aria-components';

import type { InputRequiredResult } from '~/common/mcp-debugger/protocol/mcp/elicitation';
import { isTaskTerminal, type TaskStatus } from '~/common/mcp-debugger/protocol/mcp/tasks/taskModel';
import type { TaskView } from '~/main/mcp-debugger/service';

import { JsonView } from './json-view';
import { InputRequiredResponder } from './mrtr-form';

// Task 4348 S4: a live card for one task of the `io.modelcontextprotocol/tasks` extension (status, polling controls,
// the input form while input_required, and the final result or error). Used in the Tasks panel and inline in the
// detail of the call that created the task. Ported from Ardi's TaskDetail.

const STATUS_LABEL: Record<TaskStatus, string> = {
  working: 'Working',
  input_required: 'Input required',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const STATUS_COLOR: Record<TaskStatus, string> = {
  working: 'text-amber-500',
  input_required: 'text-amber-500',
  completed: 'text-green-500',
  failed: 'text-red-500',
  cancelled: 'text-(--hl)',
};

const smallButton = 'rounded-xs border border-solid border-(--hl-md) px-2 py-0.5 text-xs hover:bg-(--hl-sm)';

const pollingNote = (task: TaskView) => {
  if (isTaskTerminal(task.status)) {
    return 'Finished';
  }
  if (task.status === 'input_required') {
    return 'Not polling: waiting for your input';
  }
  return task.paused ? 'Polling paused' : task.polling ? 'Polling automatically' : 'Checking…';
};

export const TaskCard: FC<{ requestId: string; task: TaskView }> = ({ requestId, task }) => {
  const act = (action: 'pause' | 'resume' | 'refresh' | 'cancel') =>
    window.main.mcpDebugger.taskAction({ requestId, taskId: task.taskId, action });
  const terminal = isTaskTerminal(task.status);
  const inputRequests = (task.inputRequests ?? {}) as InputRequiredResult['inputRequests'];
  const awaitingInput = task.status === 'input_required' && Object.keys(inputRequests).length > 0;

  return (
    <section className="flex flex-col gap-2 rounded-xs border border-solid border-(--hl-md) p-2" data-testid="mcp-task-card">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-xs font-bold text-(--hl) uppercase">Task</span>
          <code className="truncate text-xs" data-testid="mcp-task-id">
            {task.taskId}
          </code>
        </div>
        <span className={`flex shrink-0 items-center gap-1.5 text-xs ${STATUS_COLOR[task.status]}`} data-testid="mcp-task-status">
          {!terminal && <i className="fa fa-spinner fa-spin" aria-hidden />}
          {STATUS_LABEL[task.status]}
        </span>
      </div>
      <p className="text-xs text-(--hl)">
        {pollingNote(task)}
        {task.statusMessage ? ` · ${task.statusMessage}` : ''}
        {task.createdAt ? ` · created ${task.createdAt}` : ''}
      </p>
      {!terminal && (
        <div className="flex flex-wrap gap-2">
          {task.status === 'working' && (
            <Button className={smallButton} onPress={() => act(task.paused ? 'resume' : 'pause')} data-testid="mcp-task-pause">
              {task.paused ? 'Resume polling' : 'Pause polling'}
            </Button>
          )}
          <Button className={smallButton} onPress={() => act('refresh')} data-testid="mcp-task-refresh">
            Check now
          </Button>
          <Button className={smallButton} onPress={() => act('cancel')} data-testid="mcp-task-cancel">
            Cancel task
          </Button>
        </div>
      )}
      {awaitingInput && (
        <InputRequiredResponder
          acceptOnly
          title="This task needs input to continue"
          prompt={{ resultType: 'input_required', inputRequests, requestState: undefined }}
          onSubmit={responses => {
            // tasks/update takes the answers keyed like the task's inputRequests, without the accept wrapper.
            const inputs = Object.fromEntries(Object.entries(responses).map(([key, r]) => [key, r.content ?? {}]));
            void window.main.mcpDebugger.taskAction({ requestId, taskId: task.taskId, action: 'update', inputs });
          }}
        />
      )}
      {task.status === 'completed' && task.result !== undefined && (
        <div>
          <h4 className="mb-1 text-xs font-bold text-(--hl) uppercase">Result</h4>
          <JsonView value={task.result} />
        </div>
      )}
      {task.status === 'failed' && task.error !== undefined && (
        <div>
          <h4 className="mb-1 text-xs font-bold text-(--hl) uppercase">Error</h4>
          <JsonView value={task.error} />
        </div>
      )}
    </section>
  );
};

export const TasksPanel: FC<{ requestId: string; tasks: TaskView[] }> = ({ requestId, tasks }) => (
  <div className="flex flex-col gap-3" data-testid="mcp-tasks-panel">
    <p className="text-sm text-(--hl)">
      A tool call can return a task instead of a result. This client polls it automatically until it finishes (pause it
      any time), and the call that created it settles with the task&apos;s outcome.
    </p>
    {tasks.length === 0 && <p className="text-sm text-(--hl)">No tasks yet. Call a task tool, such as quick-success-task.</p>}
    {[...tasks].reverse().map(task => (
      <TaskCard key={task.taskId} requestId={requestId} task={task} />
    ))}
  </div>
);
