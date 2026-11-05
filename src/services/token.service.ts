import jwt from 'jsonwebtoken';
import type { ProfileType } from '../domain/entities.model';
import { UnauthorisedError } from '../errors/app.errors';

/** The claims Sentodo places in an access token. */
export interface TokenClaims {
  sub: string;
  type: ProfileType;
  exp: number;
  iat: number;
}

/** Issues and verifies HS256 access tokens. */
export class TokenService {
  /**
   * @param {string} secret - The signing secret.
   * @param {number} expiresInSeconds - Token lifetime.
   */
  constructor(private readonly secret: string, private readonly expiresInSeconds: number) {}

  /**
   * Signs an access token.
   * @param {string} profileId - The profile the token is for.
   * @param {ProfileType} type - The profile type.
   * @returns {{ token: string; expiresInSeconds: number }} The token and its lifetime.
   */
  sign(profileId: string, type: ProfileType): { token: string; expiresInSeconds: number } {
    const token = jwt.sign({ type }, this.secret, {
      algorithm: 'HS256',
      subject: profileId,
      expiresIn: this.expiresInSeconds,
    });
    return { token, expiresInSeconds: this.expiresInSeconds };
  }

  /**
   * Verifies a token.
   * @param {string} token - The raw token.
   * @returns {TokenClaims} The verified claims.
   * @throws {UnauthorisedError} If the token is malformed, tampered with or expired.
   */
  verify(token: string): TokenClaims {
    try {
      const decoded = jwt.verify(token, this.secret, { algorithms: ['HS256'] });
      if (typeof decoded === 'string' || !decoded.sub || !decoded.exp || !decoded.iat) {
        throw new UnauthorisedError('Invalid or expired token');
      }
      return decoded as unknown as TokenClaims;
    } catch (error) {
      if (error instanceof UnauthorisedError) throw error;
      throw new UnauthorisedError('Invalid or expired token');
    }
  }
}
