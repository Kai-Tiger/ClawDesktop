export type ArtifactKind = 'text' | 'json' | 'image' | 'file';

export interface ArtifactRef {
  artifactId: string;
  kind: ArtifactKind;
  mimeType: string;
  uri: string;
  name?: string;
  size?: number;
  checksum?: string;
  metadata?: Record<string, unknown>;
}

export interface TaskConstraints {
  timeoutMs?: number;
  maxRetries?: number;
  retryBackoffMs?: number;
  requireAbsolutePath?: boolean;
}

export interface TaskSpec {
  taskId: string;
  type: 'worker_message';
  fromWorkerId?: string;
  toWorkerId: string;
  intent: string;
  message: string;
  dependsOn: string[];
  artifactsIn?: ArtifactRef[];
  constraints?: TaskConstraints;
  idempotencyKey?: string;
}

export interface TaskEnvelope {
  version: 'v1';
  traceId: string;
  runId: string;
  groupId: string;
  task: TaskSpec;
}

export type TaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'timeout';

export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface TaskResult {
  version: 'v1';
  traceId: string;
  runId: string;
  groupId: string;
  taskId: string;
  workerId: string;
  status: Exclude<TaskStatus, 'pending' | 'running'>;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  output?: {
    text?: string;
    contentBlocks?: Array<{ type: 'text'; text: string } | { type: 'image'; mediaType: string; data: string }>;
  };
  artifactsOut?: ArtifactRef[];
  usage?: TokenUsage;
  error?: {
    code?: string;
    message: string;
    retryable?: boolean;
    details?: Record<string, unknown>;
  } | null;
}

export interface TaskPlan {
  analysis: string;
  tasks: TaskSpec[];
}

export interface RunState {
  version: 'v1';
  traceId: string;
  runId: string;
  groupId: string;
  tasks: TaskSpec[];
  statusByTaskId: Record<string, TaskStatus>;
  resultsByTaskId: Record<string, TaskResult>;
  artifactsByTaskId: Record<string, ArtifactRef[]>;
  errorByTaskId: Record<string, string>;
  startedAt: string;
  completedAt?: string;
}

export type RunEventType =
  | 'run.started'
  | 'task.started'
  | 'task.chunk'
  | 'task.completed'
  | 'task.failed'
  | 'run.completed'
  | 'run.failed'
  | 'run.canceled';

export interface RunEvent {
  event: RunEventType;
  timestamp: string;
  traceId: string;
  runId: string;
  groupId: string;
  taskId?: string;
  workerId?: string;
  seq?: number;
  payload?: Record<string, unknown>;
}

export const ORCHESTRATION_STATE_GRAPH_MERMAID = `stateDiagram-v2
  [*] --> PLAN
  PLAN --> VALIDATE_PLAN
  VALIDATE_PLAN --> SCHEDULE_READY: plan ok
  VALIDATE_PLAN --> RUN_FAILED: invalid plan
  SCHEDULE_READY --> EXECUTE_BATCH: has ready tasks
  SCHEDULE_READY --> FINALIZE: no pending tasks
  EXECUTE_BATCH --> MERGE_RESULTS
  MERGE_RESULTS --> SCHEDULE_READY: pending remains
  MERGE_RESULTS --> FINALIZE: all done
  EXECUTE_BATCH --> RETRY_DECISION: task error/timeout
  RETRY_DECISION --> EXECUTE_BATCH: retry allowed
  RETRY_DECISION --> MARK_FAILED: retry exhausted
  MARK_FAILED --> FAILURE_POLICY
  FAILURE_POLICY --> RUN_FAILED: fail-fast
  FAILURE_POLICY --> SCHEDULE_READY: continue-on-error
  FINALIZE --> RUN_COMPLETED
  RUN_COMPLETED --> [*]
  RUN_FAILED --> [*]
`;

export function createInitialRunState(
  traceId: string,
  runId: string,
  groupId: string,
  tasks: TaskSpec[],
): RunState {
  const statusByTaskId: Record<string, TaskStatus> = {};
  for (const task of tasks) {
    statusByTaskId[task.taskId] = 'pending';
  }
  return {
    version: 'v1',
    traceId,
    runId,
    groupId,
    tasks,
    statusByTaskId,
    resultsByTaskId: {},
    artifactsByTaskId: {},
    errorByTaskId: {},
    startedAt: new Date().toISOString(),
  };
}

export function getReadyTasks(state: RunState): TaskSpec[] {
  return state.tasks.filter((task) => {
    if (state.statusByTaskId[task.taskId] !== 'pending') return false;
    return task.dependsOn.every((depId) => state.statusByTaskId[depId] === 'completed');
  });
}

export function isRunFinished(state: RunState): boolean {
  return state.tasks.every((task) => {
    const status = state.statusByTaskId[task.taskId];
    return status === 'completed' || status === 'failed' || status === 'canceled' || status === 'timeout';
  });
}
