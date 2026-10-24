// The opener `render --open` uses, for each platform CI runs on, with `spawn` stubbed so no
// browser starts. Every platform's choice runs on every OS.
import type { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { openFile } from './open.ts';

/** A `spawn` that records its call and, on the next tick, emits `event` from the child. */
function fakeSpawn(event: 'spawn' | 'error') {
  const calls: unknown[][] = [];
  let unrefs = 0;
  const fake = (...args: unknown[]) => {
    calls.push(args);
    const child = new EventEmitter() as ChildProcess;
    child.unref = () => void unrefs++;
    setImmediate(() =>
      event === 'spawn' ? child.emit('spawn') : child.emit('error', new Error('ENOENT')),
    );
    return child;
  };
  return { spawn: fake as unknown as typeof spawn, calls, unrefs: () => unrefs };
}

describe('openFile', () => {
  it.each([
    ['darwin', 'open'],
    ['win32', 'explorer.exe'],
    ['linux', 'xdg-open'],
  ] as const)('on %s runs %s, detached, and does not wait for it', async (platform, command) => {
    const fake = fakeSpawn('spawn');
    await openFile('/r/review.html', { platform, spawn: fake.spawn });
    expect(fake.calls).toEqual([
      [command, ['/r/review.html'], { detached: true, stdio: 'ignore' }],
    ]);
    expect(fake.unrefs()).toBe(1);
  });

  it('rejects when the opener cannot start', async () => {
    const fake = fakeSpawn('error');
    await expect(
      openFile('/r/review.html', { platform: 'linux', spawn: fake.spawn }),
    ).rejects.toThrow('ENOENT');
  });
});
