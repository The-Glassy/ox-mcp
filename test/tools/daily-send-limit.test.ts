import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../src/config/env.js';
import { DailySendLimit } from '../../src/mail/daily-send-limit.js';
import { FULL_ACCOUNT_ALL_ENABLED, makeFakes, makeRegistry } from './harness.js';

const message = { to: 'recipient@example.com', subject: 'Subject' };
const config = {
  servers: {
    default: FULL_ACCOUNT_ALL_ENABLED,
    other: {
      ...FULL_ACCOUNT_ALL_ENABLED,
      mail: {
        ...FULL_ACCOUNT_ALL_ENABLED.mail,
        auth: { ...FULL_ACCOUNT_ALL_ENABLED.mail.auth, user: 'other@example.com' },
      },
    },
  },
};

let dir: string;
let file: string;
let fakes: ReturnType<typeof makeFakes>;
let now: Date;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ox-mcp-daily-'));
  file = join(dir, 'daily-send-limit.json');
  fakes = makeFakes();
  now = new Date('2026-07-14T21:59:59Z');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function registry(env: Env = {}) {
  const settings = { OX_MCP_STATE_DIR: dir, OX_MCP_SEND_LIMIT_PER_DAY: '1', ...env };
  return makeRegistry(fakes, config, settings, new DailySendLimit(settings, dir, () => now));
}

describe('mail tool daily send limit', () => {
  it('shares the cap across send and both reply tools, with one slot per message', async () => {
    const reg = registry({ OX_MCP_SEND_LIMIT_PER_DAY: '3' });
    expect(
      (await reg.dispatch('email_send', { ...message, to: ['a@example.com', 'b@example.com'] }))
        .isError,
    ).toBeFalsy();
    expect((await reg.dispatch('email_reply', { uid: 1 })).isError).toBeFalsy();
    expect((await reg.dispatch('email_reply_all', { uid: 1 })).isError).toBeFalsy();
    for (const [name, args] of [
      ['email_send', message],
      ['email_reply', { uid: 1 }],
      ['email_reply_all', { uid: 1 }],
    ] as const) {
      const result = await reg.dispatch(name, args);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(
        'daily send limit 3 reached; resets at 00:00 Europe/Vienna',
      );
    }
    expect((await reg.dispatch('email_save_draft', message)).isError).toBeFalsy();
    expect(fakes.imap.saveDraft).toHaveBeenCalledOnce();
    expect(fakes.smtp.send).toHaveBeenCalledTimes(3);
  });

  it('persists across instances, isolates accounts and resets at Vienna midnight in summer', async () => {
    expect((await registry().dispatch('email_send', message)).isError).toBeFalsy();
    expect(JSON.parse(await readFile(file, 'utf8')).accounts).toEqual([
      { id: 'default', day: '2026-07-14', count: 1 },
    ]);
    const restarted = registry();
    expect((await restarted.dispatch('email_send', message)).isError).toBe(true);
    expect(
      (await restarted.dispatch('email_send', { ...message, server: 'other' })).isError,
    ).toBeFalsy();
    now = new Date('2026-07-14T22:00:00Z');
    expect((await restarted.dispatch('email_send', message)).isError).toBeFalsy();
    expect(fakes.smtp.send).toHaveBeenCalledTimes(3);
  });

  it('uses the configured timezone', async () => {
    const reg = registry({ OX_MCP_SEND_LIMIT_TZ: 'UTC' });
    await reg.dispatch('email_send', message);
    now = new Date('2026-07-14T22:00:00Z');
    const result = await reg.dispatch('email_send', message);
    expect(result.content[0].text).toContain('resets at 00:00 UTC');
    now = new Date('2026-07-15T00:00:00Z');
    expect((await reg.dispatch('email_send', message)).isError).toBeFalsy();
  });

  it('releases a slot when the transport reports failure', async () => {
    fakes.smtp.send.mockRejectedValueOnce(new Error('SMTP refusal'));
    const result = await registry().dispatch('email_reply_all', { uid: 1 });
    expect(result.content[0].text).toContain('SMTP refusal');
    expect((await registry().dispatch('email_reply', { uid: 1 })).isError).toBeFalsy();
    expect((await registry().dispatch('email_send', message)).isError).toBe(true);
  });

  it('reserves capacity before a send finishes, including across server instances', async () => {
    let release!: (value: Awaited<ReturnType<typeof fakes.smtp.send>>) => void;
    let started!: () => void;
    const sending = new Promise<void>((resolve) => {
      started = resolve;
    });
    fakes.smtp.send.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
          started();
        }),
    );
    const first = registry().dispatch('email_send', message);
    await sending;
    try {
      expect((await registry().dispatch('email_send', message)).isError).toBe(true);
    } finally {
      release({ messageId: 'id', accepted: ['recipient@example.com'], rejected: [] });
    }
    expect((await first).isError).toBeFalsy();
    expect(fakes.smtp.send).toHaveBeenCalledOnce();
  });

  it.each(['broken JSON', '{"accounts":[{"id":"default","day":"2026-07-14","count":-1}]}'])(
    'fails closed and preserves invalid state %s',
    async (contents) => {
      await writeFile(file, contents);
      const result = await registry().dispatch('email_send', message);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('daily send limit state is unreadable');
      expect(await readFile(file, 'utf8')).toBe(contents);
      expect(fakes.smtp.send).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, '0'])('leaves sending unlimited with limit %s', async (limit) => {
    await writeFile(file, 'broken JSON');
    const reg = registry({ OX_MCP_SEND_LIMIT_PER_DAY: limit });
    expect((await reg.dispatch('email_send', message)).isError).toBeFalsy();
    expect((await reg.dispatch('email_send', message)).isError).toBeFalsy();
    expect(await readFile(file, 'utf8')).toBe('broken JSON');
  });

  it.each(['-1', '', '1.5', '1e3', '9007199254740992'])('rejects invalid limit %s', (limit) => {
    expect(() => registry({ OX_MCP_SEND_LIMIT_PER_DAY: limit })).toThrow(
      'must be a non-negative integer',
    );
  });

  it('rejects an invalid timezone with a positive limit', () => {
    expect(() => registry({ OX_MCP_SEND_LIMIT_TZ: 'Invalid/Zone' })).toThrow(
      'must be a valid timezone',
    );
  });
});
