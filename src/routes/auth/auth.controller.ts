import type { RequestHandler } from 'express';
import type { AppContainer } from '../../app.container';
import { asyncHandler } from '../../utils/asyncHandler.util';
import { sendSuccess } from '../../utils/response.util';
import { toProfileView } from '../../services/views.mapper';
import type { RegisterInput } from '../../services/auth.service';

/** HTTP handlers for authentication. Errors propagate to the central error handler. */
export function createAuthController(container: AppContainer): Record<string, RequestHandler> {
  const { auth } = container;

  return {
    register: asyncHandler(async (req, res) => {
      const profile = await auth.register(req.body as RegisterInput);
      sendSuccess(res, 201, 'Registration successful. Check your email for a verification code.', {
        profile: toProfileView(profile),
      });
    }),

    resendEmailCode: asyncHandler(async (req, res) => {
      await auth.resendEmailCode((req.body as { email: string }).email);
      sendSuccess(res, 200, 'If the email is registered and unverified, a new code has been sent.');
    }),

    verifyEmail: asyncHandler(async (req, res) => {
      const { email, code } = req.body as { email: string; code: string };
      const profile = await auth.verifyEmail(email, code);
      sendSuccess(res, 200, 'Email verified', { profile: toProfileView(profile) });
    }),

    verifyPhone: asyncHandler(async (req, res) => {
      const { phone, code } = req.body as { phone: string; code: string };
      const profile = await auth.verifyPhone(phone, code);
      sendSuccess(res, 200, 'Phone number verified', { profile: toProfileView(profile) });
    }),

    login: asyncHandler(async (req, res) => {
      const { email, password } = req.body as { email: string; password: string };
      const result = await auth.login(email, password);
      sendSuccess(res, 200, 'Signed in', {
        accessToken: result.token,
        tokenType: 'Bearer',
        expiresInSeconds: result.expiresInSeconds,
        profile: toProfileView(result.profile),
      });
    }),

    verifyToken: asyncHandler(async (req, res) => {
      const verification = await auth.verifyToken((req.body as { token: string }).token);
      sendSuccess(res, 200, 'Token is valid', verification);
    }),
  };
}
