import type { RequestHandler } from 'express';
import type { AppContainer } from '../../app.container';
import { asyncHandler } from '../../utils/asyncHandler.util';
import { failureBody, successBody } from '../../utils/response.util';

/** Liveness and readiness probes for orchestrators. */
export function createSystemController(container: AppContainer): Record<string, RequestHandler> {
  return {
    live: asyncHandler(async (_req, res) => {
      res.status(200).json(successBody('Alive', { status: 'ok', uptimeSeconds: Math.round(process.uptime()) }));
    }),

    ready: asyncHandler(async (_req, res) => {
      const entries = await Promise.all(
        Object.entries(container.healthChecks).map(async ([name, check]) => [name, await check().catch(() => false)] as const),
      );
      const checks = Object.fromEntries(entries);
      const healthy = entries.every(([, ok]) => ok);
      res.status(healthy ? 200 : 503).json(healthy ? successBody('Ready', { checks }) : failureBody('Not ready', { checks }));
    }),
  };
}
