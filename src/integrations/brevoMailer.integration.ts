import { IntegrationError } from '../errors/app.errors';
import type { Logger } from '../utils/logger.util';
import type { EmailMessage, EmailSender } from './mailer.integration';

/**
 * Brevo email integration. Sends through Brevo's HTTPS API (port 443) instead of SMTP, for hosts that block
 * SMTP ports. The sender address must first be added and verified in the Brevo dashboard.
 */

/** Settings for {@link BrevoEmailSender}. */
export interface BrevoMailerOptions {
  /** Brevo API key (not the SMTP key). */
  apiKey: string;
  /** A sender address verified in Brevo. */
  senderEmail: string;
  /** Display name shown to recipients. */
  senderName: string;
  logger: Logger;
  /** API base URL. Override for tests. Default `https://api.brevo.com`. */
  apiUrl?: string;
  /** Request timeout in milliseconds. Default 15 000. */
  timeoutMs?: number;
}

/** Brevo implementation of {@link EmailSender}. */
export class BrevoEmailSender implements EmailSender {
  private readonly apiUrl: string;
  private readonly timeoutMs: number;

  /** @param {BrevoMailerOptions} options - API key, verified sender and logger. */
  constructor(private readonly options: BrevoMailerOptions) {
    this.apiUrl = (options.apiUrl ?? 'https://api.brevo.com').replace(/\/$/, '');
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  /**
   * Sends one message. HTML is used when present, otherwise plain text. Any failure throws, so the queue
   * retries the job with backoff.
   * @param {EmailMessage} message - The message to deliver.
   * @throws {IntegrationError} If Brevo rejects the request or cannot be reached.
   */
  async send(message: EmailMessage): Promise<void> {
    const body = JSON.stringify({
      sender: { name: this.options.senderName, email: this.options.senderEmail },
      to: [{ email: message.to }],
      subject: message.subject,
      // Brevo accepts exactly one body type per request.
      ...(message.html ? { htmlContent: message.html } : { textContent: message.text }),
    });

    let response: Response;
    try {
      response = await fetch(`${this.apiUrl}/v3/smtp/email`, {
        method: 'POST',
        headers: { 'api-key': this.options.apiKey, 'content-type': 'application/json', accept: 'application/json' },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new IntegrationError('brevo', 'Unable to reach Brevo', error);
    }

    if (!response.ok) {
      // Brevo's error body (e.g. "sender not valid") helps debugging, so it goes in the cause (logs only), never the message.
      const detail = await response.text().catch(() => '');
      throw new IntegrationError('brevo', `Unable to send email (HTTP ${response.status})`, new Error(detail.slice(0, 500)));
    }
    this.options.logger.debug('Email sent via Brevo', { status: response.status });
  }
}
