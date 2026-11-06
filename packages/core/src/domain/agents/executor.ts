/**
 * Tool executor (pure framework). The ONLY path by which an agent touches the world. Everything the model proposes is
 * treated as untrusted: the tool must be on the spec's allowlist, the caller's session must be allowed to use it, the arguments
 * are re-validated against a strict schema, and `write_guarded` tools never run without a confirmation verified by the
 * confirmation endpoint (not by the model). Identity comes from `AuthContext`, never from arguments.
 */
import type { AgentId } from '@orvia/types';
import type { AnyTool, AuthContext, ExecDeps, RunState, ToolCallRecord, ToolResult } from './framework';
import { neutraliseDeep, summariseArgs } from './injection';
import { argsHash } from './policy';

/** Argument names that carry identity. A tool schema must never declare these; if a model sends them they are rejected, not ignored. */
export const FORBIDDEN_ARG_KEYS = ['userId', 'user_id', 'customerId', 'customer_id', 'accountId', 'email', 'actorId', 'role', 'permission', 'permissions', 'confirmed', 'confirmation', 'token', 'approve', 'approved', 'bypass', 'override'];

const withTimeout = <T>(p: Promise<T>, ms: number, label: string): Promise<T> => {
  let t: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms); });
  return Promise.race([p, timeout]).finally(() => { if (t) clearTimeout(t); });
};

function allowedFor(tool: AnyTool, auth: AuthContext): string | null {
  if (!tool.audience.includes(auth.kind)) return `tool "${tool.name}" is not available to ${auth.kind} sessions`;
  if (auth.kind === 'customer' && !tool.audience.includes('guest')) {
    if (!auth.userId) return 'customer tools need an authenticated session';
    if (!auth.emailVerified) return 'verify your email to use account actions';
  }
  if (tool.permission && !(auth.can?.(tool.permission) ?? false)) return `missing permission ${tool.permission}`;
  return null;
}

/** Whether a tool call needs a verified confirmation before running. */
export const needsConfirmation = (tool: AnyTool): boolean => tool.sideEffect === 'write_guarded' || !!tool.requiresConfirmation;

export async function executeTool<TIO>(deps: ExecDeps<TIO>, state: RunState, auth: AuthContext, name: string, rawArgs: unknown): Promise<ToolResult> {
  const started = Date.now();
  const record = (r: { outcome: ToolCallRecord['outcome']; reason?: string; outputBytes: number; sideEffect?: ToolCallRecord['sideEffect'] }): void => {
    state.calls.push({ tool: name, sideEffect: r.sideEffect ?? 'unknown', argsSummary: summariseArgs(rawArgs), outcome: r.outcome, reason: r.reason, ms: Date.now() - started, outputBytes: r.outputBytes });
  };
  const refuse = (reason: string, sideEffect?: ToolCallRecord['sideEffect']): ToolResult => {
    state.refusals++;
    record({ outcome: 'refused', reason, outputBytes: 0, sideEffect });
    return { ok: false, tool: name, status: 'refused', reason };
  };

  // 1. allowlist (spec level) and existence
  if (!state.allow.has(name)) { state.flags.add('tool_not_allowlisted'); return refuse('tool is not on this agent\'s allowlist'); }
  const tool = deps.tools.get(name);
  if (!tool) return refuse('unknown tool');

  // 2. run-level limits
  if (state.totalCalls >= state.maxToolCalls) { state.flags.add('limit_hit'); return refuse('tool call limit for this run reached', tool.sideEffect); }
  const used = state.perTool.get(name) ?? 0;
  if (used >= tool.limits.maxCallsPerRun) { state.flags.add('limit_hit'); return refuse(`call limit for ${name} reached`, tool.sideEffect); }

  // 3. caller authorisation (re-checked here regardless of what the model says)
  const denied = allowedFor(tool, auth);
  if (denied) return refuse(denied, tool.sideEffect);

  // 4. identity keys are never accepted as arguments (a model may try to supply another user's id)
  if (rawArgs && typeof rawArgs === 'object') {
    const bad = FORBIDDEN_ARG_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(rawArgs, k));
    if (bad.length) { state.flags.add('identity_argument_rejected'); return refuse(`arguments may not include ${bad.join(', ')}`, tool.sideEffect); }
  }

  // 5. strict argument validation
  const parsed = tool.input.safeParse(rawArgs ?? {});
  if (!parsed.success) return refuse(`invalid arguments: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || 'args'} ${i.message}`).join('; ')}`, tool.sideEffect);
  state.totalCalls++;
  state.perTool.set(name, used + 1);

  // 6. confirmation gate: money / data writes never execute on a model's say-so
  if (needsConfirmation(tool)) {
    const hash = argsHash(name, parsed.data);
    const c = auth.confirmation;
    const confirmed = !!c && auth.kind === 'customer' && c.tool === name && c.argsHash === hash;
    if (!confirmed) {
      if (!deps.pending || auth.kind !== 'customer' || !auth.userId) return refuse('this action needs the customer\'s explicit confirmation', tool.sideEffect);
      const summary = tool.describe ? tool.describe(parsed.data) : tool.description;
      const p = await deps.pending.create({ agentId: state.agentId as AgentId, tool: name, args: parsed.data, argsHash: hash, summary, auth });
      state.pending.push(p);
      record({ outcome: 'awaiting_confirmation', outputBytes: 0, sideEffect: tool.sideEffect });
      // The model (and any prompt) only learns that a confirmation is pending. The token goes to the UI through `state.pending`.
      return { ok: false, tool: name, status: 'awaiting_confirmation', reason: 'waiting for the customer to confirm', pendingId: p.actionId };
    }
  }

  // 7. run (bounded) and validate the output
  try {
    const out = await withTimeout(tool.run(deps.io, parsed.data, auth), tool.limits.timeoutMs ?? 15_000, name);
    const v = tool.output.safeParse(out);
    if (!v.success) { record({ outcome: 'error', reason: 'tool produced invalid output', outputBytes: 0, sideEffect: tool.sideEffect }); return { ok: false, tool: name, status: 'error', reason: 'tool produced invalid output' }; }
    const flag = { hit: false };
    const data = neutraliseDeep(v.data, flag);
    if (flag.hit) state.flags.add('tool_output_injection');
    const bytes = Buffer.byteLength(JSON.stringify(data));
    if (bytes > tool.limits.maxOutputBytes) { state.flags.add('limit_hit'); record({ outcome: 'refused', reason: 'output exceeds size limit', outputBytes: bytes, sideEffect: tool.sideEffect }); return { ok: false, tool: name, status: 'refused', reason: 'tool output exceeds the size limit' }; }
    record({ outcome: 'ok', outputBytes: bytes, sideEffect: tool.sideEffect });
    return { ok: true, tool: name, data };
  } catch (e) {
    const reason = (e as Error).message.slice(0, 200);
    // domain refusals (403/404/422) are policy answers, not crashes: surface them as refused so they can escalate
    const status = (e as { status?: number }).status;
    const refused = typeof status === 'number' && status >= 400 && status < 500;
    if (refused) state.refusals++;
    record({ outcome: refused ? 'refused' : 'error', reason, outputBytes: 0, sideEffect: tool.sideEffect });
    return { ok: false, tool: name, status: refused ? 'refused' : 'error', reason };
  }
}
