import type { RequestHandler } from 'express';
import type { AppContainer } from '../../app.container';
import { asyncHandler } from '../../utils/asyncHandler.util';
import { sendSuccess } from '../../utils/response.util';

/** HTTP handlers for the App Command Centre. */
export function createCommandCentreController(container: AppContainer): Record<string, RequestHandler> {
  const { commandCentre } = container;
  return {
    states: asyncHandler(async (_req, res) => {
      sendSuccess(res, 200, 'Command centre states', await commandCentre.snapshot());
    }),

    setState: asyncHandler(async (req, res) => {
      const { enabled, reason } = req.body as { enabled: boolean; reason?: string };
      const key = req.params.key;
      // Features are addressed by key ("bills.tv"); providers by identifier ("mock-tv-dstv").
      const resolved = (await commandCentre.hasKey(key)) ? key : `provider:${key}`;
      const state = await commandCentre.setState(resolved, enabled, { updatedBy: 'service-token', reason });
      await container.repositories.auditLogs.add({
        action: 'commandCentre.stateChanged',
        actorId: null,
        ip: req.ip ?? null,
        metadata: { key: resolved, enabled, reason: reason ?? null },
      });
      sendSuccess(res, 200, enabled ? 'Enabled' : 'Disabled', {
        key: state.key,
        enabled: state.enabled,
        reason: state.reason,
        updatedAt: state.updatedAt,
      });
    }),
  };
}
