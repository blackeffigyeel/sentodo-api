import type { RequestHandler } from 'express';
import type { AppContainer } from '../../app.container';
import { requireAuth } from '../../middleware/auth.middleware';
import { toProfileView } from '../../services/views.mapper';
import { asyncHandler } from '../../utils/asyncHandler.util';
import { sendSuccess } from '../../utils/response.util';

/** HTTP handlers for the signed-in profile. */
export function createProfilesController(container: AppContainer): Record<string, RequestHandler> {
  return {
    me: asyncHandler(async (req, res) => {
      const { profile } = requireAuth(req);
      sendSuccess(res, 200, 'Profile retrieved', { profile: toProfileView(profile) });
    }),

    verifyIdentity: asyncHandler(async (req, res) => {
      const { profile } = requireAuth(req);
      const verified = await container.profiles.verifyIdentity(profile.id, (req.body as { bvn: string }).bvn);
      sendSuccess(res, 200, 'Identity verified', { profile: toProfileView(verified) });
    }),
  };
}
