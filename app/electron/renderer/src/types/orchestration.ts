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

export interface WorkerMessageTask {
  taskId: string;
  type: 'worker_message';
  fromWorkerId?: string;
  toWorkerId: string;
  intent: string;
  message: string;
  dependsOn: string[];
  artifactsIn?: ArtifactRef[];
}

export interface TaskEnvelope {
  version: 'v1';
  traceId: string;
  runId: string;
  groupId: string;
  task: WorkerMessageTask;
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
