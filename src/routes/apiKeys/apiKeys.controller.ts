import type { RequestHandler } from 'express';
import type { AppContainer } from '../../app.container';
import { requireAuth } from '../../middleware/auth.middleware';
import { toApiKeyView } from '../../services/views.mapper';
import { asyncHandler } from '../../utils/asyncHandler.util';
import { sendSuccess } from '../../utils/response.util';

/** HTTP handlers for corporate API keys. */
export function createApiKeysController(container: AppContainer): Record<string, RequestHandler> {
  const { apiKeys } = container;
  return {
    create: asyncHandler(async (req, res) => {
      const { profile } = requireAuth(req);
      const { name, allowedIps } = req.body as { name: string; allowedIps: string[] };
      const { apiKey, rawKey } = await apiKeys.create(profile, name, allowedIps);
      sendSuccess(res, 201, 'API key created. Copy it now: it will not be shown again.', {
        apiKey: toApiKeyView(apiKey),
        key: rawKey,
      });
    }),

    list: asyncHandler(async (req, res) => {
      const { profile } = requireAuth(req);
      const keys = await apiKeys.list(profile);
      sendSuccess(res, 200, 'API keys retrieved', { apiKeys: keys.map(toApiKeyView) });
    }),

    updateAllowlist: asyncHandler(async (req, res) => {
      const { profile } = requireAuth(req);
      const key = await apiKeys.updateAllowlist(profile, req.params.id, (req.body as { allowedIps: string[] }).allowedIps);
      sendSuccess(res, 200, 'Allowlist updated', { apiKey: toApiKeyView(key) });
    }),

    revoke: asyncHandler(async (req, res) => {
      const { profile } = requireAuth(req);
      const key = await apiKeys.revoke(profile, req.params.id);
      sendSuccess(res, 200, 'API key revoked', { apiKey: toApiKeyView(key) });
    }),
  };
}
