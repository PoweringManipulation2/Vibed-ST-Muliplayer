/** Stay below the relay's token buckets instead of reconnecting after a normal bulk sync. */
import { LIMITS } from './protocol.js';

export class SendBudget {
    constructor({ now = () => performance.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
        this.now = now;
        this.sleep = sleep;
        this.messageCapacity = Math.floor(LIMITS.RATE_MESSAGES * 2 / 3);
        this.byteCapacity = LIMITS.MAX_FRAME_BYTES + 4096;
        this.messageRate = LIMITS.RATE_MESSAGES / LIMITS.RATE_WINDOW_MS * 0.8;
        this.byteRate = LIMITS.RATE_BYTES / LIMITS.RATE_WINDOW_MS * 0.8;
        this.messages = this.messageCapacity;
        this.bytes = this.byteCapacity;
        this.last = now();
    }

    /** Called by the socket's serialized send chain. False means its connection expired. */
    async take(bytes, isCurrent = () => true) {
        if (!Number.isFinite(bytes) || bytes < 0 || bytes > this.byteCapacity) throw new Error('Outgoing frame exceeds the send budget');
        while (isCurrent()) {
            const now = this.now();
            const elapsed = Math.max(0, now - this.last);
            this.last = now;
            this.messages = Math.min(this.messageCapacity, this.messages + elapsed * this.messageRate);
            this.bytes = Math.min(this.byteCapacity, this.bytes + elapsed * this.byteRate);
            if (this.messages >= 1 && this.bytes >= bytes) {
                this.messages--;
                this.bytes -= bytes;
                return true;
            }
            const wait = Math.max((1 - this.messages) / this.messageRate, (bytes - this.bytes) / this.byteRate, 1);
            // A long transfer must be cancellable when its socket is replaced.
            await this.sleep(Math.min(100, Math.ceil(wait)));
        }
        return false;
    }
}
