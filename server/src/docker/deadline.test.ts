import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ExecDeadline } from './deadline.js';

/**
 * The pausable iteration clock (decisions US-004).
 *
 * Driven on a fake `now` and real timers kept tiny: what matters is that the
 * *budget* is what counts down, not the wall clock, because that is the whole
 * reason a build agent can wait hours for an answer without being reaped.
 */
describe('ExecDeadline', () => {
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

  it('expires once, after the whole budget, and stops when told to', async () => {
    const deadline = new ExecDeadline(20);
    let expired = 0;
    const stop = deadline.start(() => (expired += 1));
    assert.equal(deadline.isRunning, true);
    assert.equal(expired, 0);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(expired, 1);
    assert.equal(deadline.hasExpired, true);
    assert.equal(deadline.remainingMs, 0);
    stop();
    stop(); // Safe twice: the iteration may be unwound by two paths.
    await tick();
    assert.equal(expired, 1);
  });

  it('does not expire while paused, however long the pause is', async () => {
    let clock = 1_000;
    const deadline = new ExecDeadline(100, () => clock);
    let expired = 0;
    deadline.start(() => (expired += 1));

    clock += 30; // 30 of the 100 spent working.
    deadline.pause();
    assert.equal(deadline.isRunning, false);
    assert.equal(deadline.remainingMs, 70);

    // Four hours with a question open. Nothing is charged for them.
    clock += 4 * 60 * 60_000;
    await tick();
    assert.equal(expired, 0, 'a paused clock cannot expire');
    assert.equal(deadline.remainingMs, 70);

    deadline.resume();
    assert.equal(deadline.isRunning, true);
    assert.equal(deadline.remainingMs, 70, 'the resume starts from what was left');
  });

  it('resumes with the remaining budget, so the agent gets the minutes it was promised', async () => {
    const deadline = new ExecDeadline(60);
    let expired = 0;
    deadline.start(() => (expired += 1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    deadline.pause();
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(expired, 0);
    deadline.resume();
    // Something under 40ms of budget is left: it expires soon, but not at once.
    await tick();
    assert.equal(expired, 0);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(expired, 1);
  });

  it('ignores a pause or a resume that cannot mean anything', async () => {
    const deadline = new ExecDeadline(50);
    // Before the start there is no clock to stop.
    deadline.pause();
    deadline.resume();
    assert.equal(deadline.isRunning, false);

    deadline.start(() => undefined);
    deadline.resume(); // Already running: a second timer would double-expire.
    assert.equal(deadline.isRunning, true);

    await new Promise((resolve) => setTimeout(resolve, 70));
    assert.equal(deadline.hasExpired, true);
    // An answer that arrives after the agent was already reaped must not
    // restart a clock for an exec that has gone.
    deadline.resume();
    assert.equal(deadline.isRunning, false);
    deadline.pause();
    assert.equal(deadline.hasExpired, true);
  });
});
