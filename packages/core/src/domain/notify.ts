import { Notification } from '@orvia/database';
import { renderTemplate } from '@orvia/notifications';
import type { Channel, TemplateData, TemplateName } from '@orvia/notifications';
import type { Ctx } from '../infra/context';

export interface NotifyInput {
  template: TemplateName;
  to: string;
  channel?: Channel;
  data: TemplateData;
  orderId?: string;
  userId?: string;
  /** Idempotency: the same dedupeKey is only ever sent once. */
  dedupeKey?: string;
}

/** Queue a notification (durable). Returns null if it was a duplicate. */
export async function notify(ctx: Ctx, i: NotifyInput): Promise<string | null> {
  const tpl = renderTemplate(i.template, i.data);
  let doc;
  try {
    doc = await Notification.create({
      to: i.to,
      channel: i.channel ?? 'email',
      template: i.template,
      subject: tpl.subject,
      body: tpl.body,
      status: 'queued',
      orderId: i.orderId,
      userId: i.userId,
      dedupeKey: i.dedupeKey,
    });
  } catch (e) {
    if ((e as { code?: number }).code === 11000) return null;
    throw e;
  }
  await ctx.queue.enqueue('send_notification', { notificationId: String(doc._id), html: tpl.html }, { maxAttempts: 4 });
  return String(doc._id);
}

/** Job handler: actually sends. Honest statuses: sent | logged_dev | skipped (no provider) | failed. */
export async function deliverNotification(ctx: Ctx, p: { notificationId: string; html?: string }): Promise<void> {
  const n = await Notification.findById(p.notificationId);
  if (!n || n.status === 'sent' || n.status === 'logged_dev') return;
  const provider = ctx.notifier.providerFor(n.channel as Channel);
  if (!provider) {
    n.status = 'skipped';
    n.error = `No ${n.channel} provider configured`;
    await n.save();
    ctx.log.warn({ channel: 'app', notification: p.notificationId }, n.error);
    return;
  }
  try {
    const out = await provider.send({ channel: n.channel as Channel, to: n.to ?? '', subject: n.subject ?? undefined, body: n.body ?? '', html: p.html });
    n.status = out.status === 'sent' ? 'sent' : 'logged_dev';
    n.provider = out.provider;
    n.providerMessageId = out.status === 'sent' ? out.providerMessageId : undefined;
    n.error = undefined;
    await n.save();
    if (out.status === 'logged_dev') ctx.log.info({ channel: 'app', to: n.to, subject: n.subject }, 'notification logged (dev provider, not delivered)');
  } catch (e) {
    n.status = 'failed';
    n.error = (e as Error).message;
    await n.save();
    throw e; // let the queue retry with backoff
  }
}
