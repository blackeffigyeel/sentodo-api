import bcrypt from 'bcryptjs';
import type { Profile, ProfileType } from '../domain/entities.model';
import { COST_SCHEDULE } from '../domain/pricing.rules';
import { BadRequestError, ForbiddenError, UnauthorisedError } from '../errors/app.errors';
import type { SmsProvider } from '../providers/provider.types';
import type { EmailJob, JobQueue } from '../queues/queue.types';
import type { Repositories } from '../repositories/interfaces/repositories.interface';
import { generateNumericCode, safeEqual, sha256 } from '../utils/crypto.util';
import type { AccountService } from './account.service';
import type { AppCommandCentre } from './commandCentre.service';
import type { TokenService } from './token.service';
import { displayName } from './views.mapper';

/** Registration input after validation. */
export interface RegisterInput {
  type: ProfileType;
  email: string;
  phone: string;
  password: string;
  firstName?: string;
  lastName?: string;
  businessName?: string;
}

/** Tunables for {@link AuthService}. */
export interface AuthOptions {
  codeTtlSeconds: number;
  maxAttempts: number;
  /** bcrypt cost factor. Lower values are only for tests. */
  bcryptRounds: number;
}

/** The outcome of a successful sign-in. */
export interface LoginResult {
  token: string;
  expiresInSeconds: number;
  profile: Profile;
}

/** The outcome of verifying a token. */
export interface TokenVerification {
  valid: true;
  profileId: string;
  profileType: ProfileType;
  expiresAt: Date;
}

const DUMMY_HASH = '$2a$10$CwTycUXWue0Thq9StjUM0uJ8.2n3jYyXk3Cq6c4z3nYh3n5d3m0uW';

/** Registration, verification, sign-in and token verification. */
export class AuthService {
  constructor(
    private readonly repositories: Repositories,
    private readonly commandCentre: AppCommandCentre,
    private readonly tokens: TokenService,
    private readonly accounts: AccountService,
    private readonly emailQueue: JobQueue<EmailJob>,
    private readonly sms: SmsProvider,
    private readonly options: AuthOptions,
  ) {}

  /**
   * Registers a profile and emails a verification code.
   * @param {RegisterInput} input - The validated registration data.
   * @returns {Promise<Profile>} The new, unverified profile.
   * @throws {ConflictError} If the email or phone number is already registered.
   */
  async register(input: RegisterInput): Promise<Profile> {
    await this.commandCentre.assertFeature('registration');
    const passwordHash = await bcrypt.hash(input.password, this.options.bcryptRounds);
    const profile = await this.repositories.profiles.create({
      type: input.type,
      email: input.email,
      phone: input.phone,
      passwordHash,
      firstName: input.firstName,
      lastName: input.lastName,
      businessName: input.businessName,
    });
    await this.sendEmailCode(profile);
    await this.repositories.auditLogs.add({ action: 'profile.registered', actorId: profile.id, ip: null, metadata: { type: profile.type } });
    return profile;
  }

  /**
   * Sends a fresh email code. The result never reveals whether the email is registered.
   * @param {string} email - The email address.
   */
  async resendEmailCode(email: string): Promise<void> {
    const profile = await this.repositories.profiles.findByEmail(email);
    if (profile && !profile.emailVerifiedAt) await this.sendEmailCode(profile);
  }

  private async sendEmailCode(profile: Profile): Promise<void> {
    const code = generateNumericCode(6);
    await this.repositories.verificationCodes.replace({
      profileId: profile.id,
      channel: 'EMAIL',
      codeHash: this.hashCode(profile.id, code),
      expiresAt: new Date(Date.now() + this.options.codeTtlSeconds * 1000),
    });
    await this.repositories.costs.add({ type: 'EMAIL', amount: COST_SCHEDULE.EMAIL, profileId: profile.id });
    const minutes = Math.round(this.options.codeTtlSeconds / 60);
    await this.emailQueue.add({
      to: profile.email,
      subject: 'Your Sentodo verification code',
      text: `Hello ${displayName(profile)},\n\nYour Sentodo MFB verification code is ${code}. It expires in ${minutes} minutes.\n\nIf you did not create this account, ignore this email.`,
    });
  }

  private hashCode(profileId: string, code: string): string {
    return sha256(`${profileId}:${code}`);
  }

  /**
   * Verifies an email address with the emailed code.
   * @param {string} email - The email address.
   * @param {string} code - The 6-digit code.
   * @returns {Promise<Profile>} The updated profile.
   * @throws {BadRequestError} If the code is wrong, expired or exhausted.
   */
  async verifyEmail(email: string, code: string): Promise<Profile> {
    const profile = await this.repositories.profiles.findByEmail(email);
    const invalid = new BadRequestError('Invalid or expired verification code');
    if (!profile) throw invalid;
    if (profile.emailVerifiedAt) return profile;

    const stored = await this.repositories.verificationCodes.findActive(profile.id, 'EMAIL');
    if (!stored || stored.attempts >= this.options.maxAttempts) throw invalid;

    if (!safeEqual(stored.codeHash, this.hashCode(profile.id, code))) {
      await this.repositories.verificationCodes.incrementAttempts(stored.id);
      throw invalid;
    }
    await this.repositories.verificationCodes.markConsumed(stored.id);
    const updated = await this.repositories.profiles.update(profile.id, { emailVerifiedAt: new Date() });
    await this.provisionFirstAccount(updated);
    return updated;
  }

  /**
   * Verifies a phone number. No SMS is sent: any code on the configured list of 6-digit
   * mock codes is accepted.
   * @param {string} phone - The 11-digit phone number.
   * @param {string} code - A 6-digit code.
   * @returns {Promise<Profile>} The updated profile.
   * @throws {BadRequestError} If the number is unknown or the code is not accepted.
   */
  async verifyPhone(phone: string, code: string): Promise<Profile> {
    const profile = await this.repositories.profiles.findByPhone(phone);
    const invalid = new BadRequestError('Invalid or expired verification code');
    if (!profile) throw invalid;
    if (profile.phoneVerifiedAt) return profile;
    if (!(await this.sms.verifyCode(phone, code))) throw invalid;

    await this.repositories.costs.add({ type: 'SMS_OTP', amount: COST_SCHEDULE.SMS_OTP, profileId: profile.id });
    const updated = await this.repositories.profiles.update(profile.id, { phoneVerifiedAt: new Date() });
    await this.provisionFirstAccount(updated);
    return updated;
  }

  /** Creates the first account once both the email and the phone number are verified. */
  private async provisionFirstAccount(profile: Profile): Promise<void> {
    if (!profile.emailVerifiedAt || !profile.phoneVerifiedAt) return;
    const existing = await this.repositories.accounts.listByProfile(profile.id);
    if (existing.length === 0) await this.accounts.openAccount(profile.id, displayName(profile));
  }

  /**
   * Signs a profile in.
   * @param {string} email - The email address.
   * @param {string} password - The password.
   * @returns {Promise<LoginResult>} A signed access token and the profile.
   * @throws {UnauthorisedError} If the credentials are wrong.
   * @throws {ForbiddenError} If the profile is suspended or not fully verified.
   */
  async login(email: string, password: string): Promise<LoginResult> {
    await this.commandCentre.assertFeature('login');
    const profile = await this.repositories.profiles.findByEmail(email);
    // Compare against a dummy hash when the profile is missing so timing does not reveal it.
    const matches = await bcrypt.compare(password, profile?.passwordHash ?? DUMMY_HASH);
    if (!profile || !matches) throw new UnauthorisedError('Invalid email or password');
    if (profile.status !== 'ACTIVE') throw new ForbiddenError('This profile has been suspended');
    if (!profile.emailVerifiedAt || !profile.phoneVerifiedAt) {
      throw new ForbiddenError('Verify your email and phone number before signing in', {
        emailVerified: profile.emailVerifiedAt !== null,
        phoneVerified: profile.phoneVerifiedAt !== null,
      });
    }
    const { token, expiresInSeconds } = this.tokens.sign(profile.id, profile.type);
    return { token, expiresInSeconds, profile };
  }

  /**
   * Verifies an access token and that its profile is still active.
   * @param {string} token - The raw token.
   * @returns {Promise<TokenVerification>} The verified identity and expiry.
   * @throws {UnauthorisedError} If the token is invalid, expired, or its profile is gone or suspended.
   */
  async verifyToken(token: string): Promise<TokenVerification> {
    const claims = this.tokens.verify(token);
    const profile = await this.repositories.profiles.findById(claims.sub);
    if (!profile || profile.status !== 'ACTIVE') throw new UnauthorisedError('Invalid or expired token');
    return { valid: true, profileId: profile.id, profileType: profile.type, expiresAt: new Date(claims.exp * 1000) };
  }
}
