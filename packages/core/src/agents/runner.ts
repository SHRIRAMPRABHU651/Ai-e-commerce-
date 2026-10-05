import { AiTask } from '@orvia/database';
import { metrics, retry, ProviderError } from '@orvia/config';
import type { ZodType, ZodTypeDef } from 'zod';
import { audit } from '../infra/audit';
import { aiActor, DomainError } from '../infra/context';
import type { Ctx } from '../infra/context';
import type { AutomationKey } from '@orvia/types';

/** Every agent's output carries a confidence and a concise explanation (never private reasoning). */
export interface AgentOutput {
  confidence: number;
  summary: string;
}

export interface AgentSpec<I, O extends AgentOutput> {
  name: string;
  description: string;
  inputSchema: ZodType<I, ZodTypeDef, unknown>;
  outputSchema: ZodType<O, ZodTypeDef, unknown>;
  /** Tools (domain functions / providers) the agent is allowed to call — documentation + audit. */
  tools: string[];
  /** Automation switches that gate the agent's side-effects. */
  permissions: AutomationKey[];
  timeoutMs: number;
  retries: number;
  run: (ctx: Ctx, input: I) => Promise<O>;
}

function withTimeout<T>(p: Promise<T>, ms: number, name: string): Promise<T> {
  let t: NodeJS.Timeout;
  const timeout = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new ProviderError(`Agent ${name} timed out after ${ms}ms`, { provider: name, retryable: true })), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

/** Validates input and output, enforces timeout + retry policy, and records an ai_task for observability. */
export async function runAgent<I, O extends AgentOutput>(ctx: Ctx, spec: AgentSpec<I, O>, rawInput: unknown): Promise<O> {
  const parsed = spec.inputSchema.safeParse(rawInput);
  if (!parsed.success) throw new DomainError(`Invalid input for ${spec.name}: ${parsed.error.issues.map((i) => i.message).join(', ')}`, 'BAD_AGENT_INPUT', 422);
  const task = await AiTask.create({ agent: spec.name, status: 'running', input: parsed.data as never });
  const started = Date.now();
  let attempts = 0;
  try {
    const out = await retry(
      async () => {
        attempts++;
        const o = await withTimeout(spec.run(ctx, parsed.data), spec.timeoutMs, spec.name);
        const v = spec.outputSchema.safeParse(o);
        if (!v.success) throw new DomainError(`${spec.name} produced invalid output: ${v.error.issues.map((i) => i.message).join(', ')}`, 'BAD_AGENT_OUTPUT', 500);
        return v.data;
      },
      { retries: spec.retries, baseMs: 500, shouldRetry: (e) => e instanceof ProviderError && e.retryable },
    );
    await AiTask.updateOne({ _id: task._id }, { $set: { status: 'succeeded', output: out as never, confidence: out.confidence, summary: out.summary, durationMs: Date.now() - started, attempts, provider: ctx.ai.llmConfigured ? 'gemini+rules' : 'rules' } });
    metrics.inc('orvia_ai_tasks_total', { agent: spec.name, status: 'ok' });
    await audit(ctx, aiActor(spec.name), { action: 'agent.run', resource: 'ai_task', resourceId: String(task._id), aiSummary: out.summary });
    return out;
  } catch (e) {
    await AiTask.updateOne({ _id: task._id }, { $set: { status: 'failed', error: (e as Error).message, durationMs: Date.now() - started, attempts } });
    metrics.inc('orvia_ai_tasks_total', { agent: spec.name, status: 'failed' });
    metrics.inc('orvia_ai_failures_total', { agent: spec.name });
    ctx.log.error({ channel: 'ai', agent: spec.name, err: (e as Error).message }, 'agent failed');
    throw e;
  }
}
