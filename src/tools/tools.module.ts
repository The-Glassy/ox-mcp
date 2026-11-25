import { ContainerModule } from 'inversify';
import { TYPES } from '../core/types.js';
import { DailySendLimit } from '../mail/daily-send-limit.js';
import type { Env } from '../config/env.js';
import type { PathProvider } from '../platform/path-provider.js';
import { ToolRegistry } from './registry.js';

export const toolsModule = new ContainerModule((bind) => {
  bind<DailySendLimit>(TYPES.DailySendLimit)
    .toDynamicValue(({ container }) => new DailySendLimit(
      container.get<Env>(TYPES.Env),
      container.get<PathProvider>(TYPES.PathProvider).configDir(),
    ))
    .inSingletonScope();
  bind<ToolRegistry>(TYPES.ToolRegistry).to(ToolRegistry).inSingletonScope();
});
