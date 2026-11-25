import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import { z } from 'zod';
import type { Env } from '../config/env.js';

const stateSchema = z
  .object({
    accounts: z
      .array(
        z
          .object({
            id: z.string(),
            day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            count: z.number().int().nonnegative().safe(),
          })
          .strict(),
      )
      .refine((accounts) => new Set(accounts.map(({ id }) => id)).size === accounts.length),
  })
  .strict();

type State = z.infer<typeof stateSchema>;

/** A durable reservation covers the window between SMTP acceptance and tool completion. */
export class DailySendLimit {
  private readonly limit: number;
  private readonly timezone: string;
  private readonly calendar: Intl.DateTimeFormat | undefined;
  private readonly dir: string;
  private readonly file: string;

  constructor(
    env: Env,
    configDir: string,
    private readonly now = () => new Date(),
  ) {
    const raw = env.OX_MCP_SEND_LIMIT_PER_DAY?.trim() ?? '0';
    this.limit = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(this.limit)) {
      throw new Error('OX_MCP_SEND_LIMIT_PER_DAY must be a non-negative integer');
    }

    this.timezone = env.OX_MCP_SEND_LIMIT_TZ ?? 'Europe/Vienna';
    if (this.limit > 0) {
      try {
        this.calendar = new Intl.DateTimeFormat('en-CA', {
          timeZone: this.timezone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        });
      } catch (cause) {
        throw new Error('OX_MCP_SEND_LIMIT_TZ must be a valid timezone', { cause });
      }
    }
    this.dir = env.OX_MCP_STATE_DIR ?? join(configDir, 'state');
    if (this.limit > 0 && !this.dir.trim()) {
      throw new Error('OX_MCP_STATE_DIR must be a directory path');
    }
    this.file = join(this.dir, 'daily-send-limit.json');
  }

  async send<T>(account: string, deliver: () => Promise<T>): Promise<T> {
    if (!this.calendar) return deliver();
    const calendar = this.calendar;
    const day = await this.update((state) => {
      const parts = Object.fromEntries(
        calendar.formatToParts(this.now()).map(({ type, value }) => [type, value]),
      );
      const today = `${parts.year}-${parts.month}-${parts.day}`;
      const row = state.accounts.find(({ id }) => id === account);
      const count = row?.day === today ? row.count : 0;
      if (count >= this.limit) {
        throw new Error(`daily send limit ${this.limit} reached; resets at 00:00 ${this.timezone}`);
      }
      if (row) {
        row.day = today;
        row.count = count + 1;
      } else {
        state.accounts.push({ id: account, day: today, count: 1 });
      }
      return today;
    });

    try {
      return await deliver();
    } catch (error) {
      // A crash with an unknown delivery outcome keeps the reservation through midnight.
      await this.update((state) => {
        const row = state.accounts.find(({ id }) => id === account);
        if (row?.day === day && row.count > 0) row.count--;
      });
      throw error;
    }
  }

  private async update<T>(mutate: (state: State) => T): Promise<T> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const release = await lockfile
      .lock(this.file, {
        realpath: false,
        stale: 30_000,
        retries: { retries: 8, factor: 1, minTimeout: 25, maxTimeout: 25 },
      })
      .catch((cause: unknown) => {
        throw new Error('daily send limit state is unavailable', { cause });
      });
    try {
      const state = await this.readState();
      const result = mutate(state);
      await this.writeState(state);
      return result;
    } finally {
      await release();
    }
  }

  private async readState(): Promise<State> {
    try {
      const info = await lstat(this.file).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
      if (!info) return { accounts: [] };
      if (!info.isFile()) throw new Error('expected a regular file');
      return stateSchema.parse(JSON.parse(await readFile(this.file, 'utf8')));
    } catch (cause) {
      throw new Error('daily send limit state is unreadable', { cause });
    }
  }

  private async writeState(state: State): Promise<void> {
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      const file = await open(temp, 'wx', 0o600);
      try {
        await file.writeFile(`${JSON.stringify(state)}\n`);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temp, this.file);
      if (process.platform !== 'win32') {
        const dir = await open(this.dir, 'r');
        try {
          await dir.sync();
        } finally {
          await dir.close();
        }
      }
    } catch (cause) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw new Error('daily send limit state could not be saved', { cause });
    }
  }
}
