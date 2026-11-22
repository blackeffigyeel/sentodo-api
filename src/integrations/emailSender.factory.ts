import type { AppConfig } from '../config/app.config';
import type { Logger } from '../utils/logger.util';
import { BrevoEmailSender } from './brevoMailer.integration';
import { NodemailerEmailSender, type EmailSender } from './mailer.integration';

/**
 * Chooses the email provider from configuration (`EMAIL_PROVIDER`): SMTP via Nodemailer, or Brevo over HTTPS.
 * Business code only ever sees {@link EmailSender}.
 * @param {AppConfig} config - The validated application configuration.
 * @param {Logger} logger - Logger passed to the chosen sender.
 * @returns {EmailSender} The configured sender.
 * @throws {Error} If Brevo is selected but its settings are incomplete (config validation normally catches this first).
 */
export function createEmailSender(config: AppConfig, logger: Logger): EmailSender {
  if (config.emailProvider === 'brevo') {
    const { apiKey, senderEmail, senderName } = config.brevo;
    if (!apiKey || !senderEmail) {
      throw new Error('EMAIL_PROVIDER=brevo requires BREVO_API_KEY and BREVO_SENDER_EMAIL');
    }
    return new BrevoEmailSender({ apiKey, senderEmail, senderName, logger });
  }
  return new NodemailerEmailSender(config.smtp, logger);
}
