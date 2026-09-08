import { canonicalJson, parseTask } from '../events/index.ts';
export interface ConfirmChannel {
  publish(exchange: string, routingKey: string, body: Uint8Array, options: {persistent: true; mandatory: true; messageId: string; contentType: string}, confirm: (error: Error | null) => void): boolean;
  on(event: 'return' | 'close' | 'error' | 'drain', listener: (...args: any[]) => void): unknown;
  off(event: 'return' | 'close' | 'error' | 'drain', listener: (...args: any[]) => void): unknown;
}
/** Driver adapter converts Uint8Array to Buffer for amqplib. Never share this channel with other publishers. */
export class RabbitTaskPublisher {
  private channel: ConfirmChannel;
  private timeoutMs: number;
  private closed = false;
  private blocked = false;
  private jobs = new Set<string>();
  private pending = new Map<string, {jobId: string; resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>}>();
  private returned = (message: {properties?: {messageId?: string}}) => {
    const id = message.properties?.messageId;
    if (id) this.finish(id, new Error('UNROUTABLE_TASK'));
  };
  private failed = () => { this.closed = true; for (const id of [...this.pending.keys()]) this.finish(id, new Error('CHANNEL_UNAVAILABLE')); };
  private drained = () => { this.blocked = false; };
  constructor(channel: ConfirmChannel, timeoutMs = 10000) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error('INVALID_CONFIRM_TIMEOUT');
    this.channel = channel; this.timeoutMs = timeoutMs;
    channel.on('return', this.returned); channel.on('close', this.failed); channel.on('error', this.failed); channel.on('drain', this.drained);
  }
  private finish(id: string, error: Error | null) {
    const entry = this.pending.get(id); if (!entry) return;
    clearTimeout(entry.timer); this.pending.delete(id); this.jobs.delete(entry.jobId);
    if (error) entry.reject(error); else entry.resolve();
  }
  async publish(input: unknown): Promise<void> {
    const task = parseTask(input);
    if (this.closed || this.blocked || this.pending.size >= 128) throw new Error('PUBLISHER_BACKPRESSURE');
    if (this.jobs.has(task.jobId)) throw new Error('DUPLICATE_IN_FLIGHT');
    const publicationId = crypto.randomUUID();
    const body = new TextEncoder().encode(canonicalJson(task));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.finish(publicationId, new Error('CONFIRM_TIMEOUT')), this.timeoutMs);
      this.jobs.add(task.jobId);
      this.pending.set(publicationId, {jobId: task.jobId, resolve, reject, timer});
      try {
        const writable = this.channel.publish('fs.commands', task.jobType, body, {persistent: true, mandatory: true, messageId: publicationId, contentType: 'application/json'}, error => this.finish(publicationId, error));
        if (!writable) this.blocked = true;
      } catch { this.finish(publicationId, new Error('PUBLISH_FAILED')); }
    });
  }
  dispose(): void {
    this.failed();
    this.channel.off('return', this.returned); this.channel.off('close', this.failed); this.channel.off('error', this.failed); this.channel.off('drain', this.drained);
  }
}
