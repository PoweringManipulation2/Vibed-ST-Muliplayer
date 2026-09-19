import test from 'node:test';
import assert from 'node:assert/strict';
import { SendBudget } from '../lib/send-budget.js';
import { LIMITS } from '../lib/protocol.js';

function clock() {
    let time = 0, waits = 0;
    const budget = new SendBudget({ now: () => time, sleep: async ms => { time += ms; waits++; } });
    return { budget, get time() { return time; }, get waits() { return waits; } };
}
await test('700 outgoing messages remain within the relay token bucket with a fake clock', async () => {
    const c = clock(); let tokens = LIMITS.RATE_MESSAGES, last = 0;
    for (let i = 0; i < 700; i++) {
        assert.equal(await c.budget.take(100), true);
        tokens = Math.min(LIMITS.RATE_MESSAGES, tokens + (c.time - last) * LIMITS.RATE_MESSAGES / LIMITS.RATE_WINDOW_MS);
        assert.ok(tokens >= 1, `relay message budget exhausted at frame ${i}`);
        tokens--; last = c.time;
    }
    assert.ok(c.waits > 0);
});
await test('large encrypted frames are paced against bytes as well as message count', async () => {
    const c = clock(); let tokens = LIMITS.RATE_BYTES, last = 0;
    for (let i = 0; i < 40; i++) {
        const size = 1024 * 1024;
        assert.equal(await c.budget.take(size), true);
        tokens = Math.min(LIMITS.RATE_BYTES, tokens + (c.time - last) * LIMITS.RATE_BYTES / LIMITS.RATE_WINDOW_MS);
        assert.ok(tokens >= size, `relay byte budget exhausted at frame ${i}`);
        tokens -= size; last = c.time;
    }
    assert.ok(c.time > 0);
});
await test('cancelled connections stop waiting without a send', async () => {
    const c = clock();
    assert.equal(await c.budget.take(1, () => false), false);
    assert.equal(c.waits, 0);
});
await test('oversized and invalid frames fail immediately rather than waiting forever', async () => {
    const c = clock();
    for (const bytes of [Infinity, NaN, -1, LIMITS.MAX_FRAME_BYTES + 5000]) await assert.rejects(c.budget.take(bytes), /budget/);
    assert.equal(c.waits, 0);
});
