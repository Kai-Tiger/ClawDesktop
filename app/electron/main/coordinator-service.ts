import type { OpenClawPaths } from './paths';
import type { ConfigService } from './config-service';

export class CoordinatorService {
  constructor(
    private readonly paths: OpenClawPaths,
    private readonly config: ConfigService
  ) {}

  async coordinatorPlan(
    userMessage: string,
    workers: { id: string; name: string; description?: string }[],
    fileContext?: string
  ): Promise<string> {
    const workerList = workers
      .map((w) => `- id: "${w.id}", name: "${w.name}"${w.description ? `, description: "${w.description}"` : ''}`)
      .join('\n');

    const systemPrompt = `You are a task coordinator in a group chat. Analyze the user's request and output an execution plan for the available workers.

Available workers:
${workerList}

Output ONLY valid JSON with no markdown fences or explanation:
{
  "analysis": "brief analysis in Chinese describing task breakdown and order",
  "tasks": [
    {
      "id": "t1",
      "workerId": "worker-id",
      "message": "specific message to send to this worker in Chinese, include all context needed",
      "after": []
    }
  ]
}

Rules:
- "after" lists task IDs that must complete before this task starts; empty = start immediately
- Only use workerIds from the available workers list
- CRITICAL: You MUST create exactly one task for EVERY worker listed above. Do not skip any worker, do not merge two workers into one task. Each worker in the list must appear as the "workerId" in at least one task.
- CRITICAL: Respect the order implied by the user's request. If the user says "A does X then passes to B", A's task must come first (after: []) and B's task must depend on it (after: ["A's task id"]).
- CRITICAL: NEVER tell any worker to call, invoke, or contact another worker. Workers cannot communicate with each other.
- Keep each worker's message short and direct — just state the intent. Do NOT add implementation details, file paths, command examples, or how-to instructions. Each worker has its own skills and knows how to handle the task.
- The orchestration system automatically prepends the output of prior tasks under "前置任务结果：" in the dependent worker's message. For dependent tasks, only say what to do with that output (e.g. "请执行前置任务结果中的Python脚本"), do NOT reproduce or describe it.
- Do NOT say "ask worker X" or "get the result from worker X".
- If the user mentions a file, just reference it by name in the task message; the actual file content is injected automatically by the execution layer, do NOT include or reproduce any file content
- CRITICAL: Whenever a task message involves any file path (input, output, or intermediate), instruct the worker to use and output ABSOLUTE paths only. Never use relative paths like ./foo or ../bar`;

    const userContent = fileContext
      ? `${userMessage}\n\n[附件内容]\n${fileContext}`
      : userMessage;

    const openRouterKey = this.config.getOpenRouterKey();

    let url: string;
    let headers: Record<string, string> = { 'Content-Type': 'application/json' };
    let model: string;

    if (openRouterKey) {
      url = 'https://openrouter.ai/api/v1/chat/completions';
      headers['Authorization'] = `Bearer ${openRouterKey}`;
      model = 'anthropic/claude-sonnet-4.6';
    } else {
      url = `http://127.0.0.1:${this.paths.gatewayPort}/v1/chat/completions`;
      const gatewayToken = this.paths.getGatewayToken();
      if (gatewayToken) headers['Authorization'] = `Bearer ${gatewayToken}`;
      model = 'openclaw';
    }

    const coordT0 = Date.now();
    const coordMs = () => `+${Date.now() - coordT0}ms`;
    this.paths.writeChatLog(`[coordinator] START model=${model} workers=${workers.map((w) => w.id).join(',')} msgLen=${userMessage.length} hasFile=${!!fileContext}`);

    const fetchT = Date.now();
    this.paths.writeChatLog(`[coordinator] fetch → POST ${url}`);
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
      }),
    });
    this.paths.writeChatLog(`[coordinator] fetch ← ${res.status} (${Date.now() - fetchT}ms)`);

    if (!res.ok) {
      this.paths.writeChatLog(`[coordinator] FAIL HTTP ${res.status} total=${coordMs()}`);
      throw new Error(`coordinator HTTP ${res.status}`);
    }
    const json = await res.json() as unknown;
    const reply = this.extractReplyText(json);
    this.paths.writeChatLog(`[coordinator] DONE replyLen=${reply.length} total=${coordMs()}`);
    return reply;
  }

  private extractReplyText(json: unknown): string {
    if (!json || typeof json !== 'object') return '';
    const root = json as {
      choices?: Array<{ message?: { content?: unknown } }>;
      output_text?: unknown;
    };
    if (typeof root.output_text === 'string' && root.output_text.trim()) return root.output_text;
    const messageContent = root.choices?.[0]?.message?.content;
    if (typeof messageContent === 'string' && messageContent.trim()) return messageContent;
    return '';
  }
}
