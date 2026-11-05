import nodemailer, { type Transporter } from 'nodemailer';
import { IntegrationError } from '../errors/app.errors';
import type { Logger } from '../utils/logger.util';

/**
 * Email integration (Nodemailer). Services depend on {@link EmailSender}, not on Nodemailer,
 * so the provider can be replaced (SES, SendGrid, ...) without touching business code.
 */

/** A plain email message. */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/** Contract for anything that can deliver email. */
export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

/** SMTP settings. When `host` is absent, messages are rendered as JSON and logged (development). */
export interface MailerOptions {
  host?: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
}

/** Nodemailer implementation of {@link EmailSender}. */
export class NodemailerEmailSender implements EmailSender {
  private readonly transporter: Transporter;

  /**
   * @param {MailerOptions} options - SMTP settings.
   * @param {Logger} logger - Logger used when no SMTP host is configured.
   */
  constructor(private readonly options: MailerOptions, private readonly logger: Logger) {
    this.transporter = options.host
      ? nodemailer.createTransport({
          host: options.host,
          port: options.port,
          secure: options.secure,
          auth: options.user ? { user: options.user, pass: options.pass } : undefined,
        })
      : nodemailer.createTransport({ jsonTransport: true });
  }

  async send(message: EmailMessage): Promise<void> {
    try {
      const info = await this.transporter.sendMail({ from: this.options.from, ...message });
      if (!this.options.host) {
        this.logger.info('Email (development transport, not delivered)', { to: message.to, subject: message.subject });
      } else {
        this.logger.debug('Email sent', { messageId: info.messageId });
      }
    } catch (error) {
      throw new IntegrationError('nodemailer', 'Unable to send email', error);
    }
  }
}

/** Collects messages in memory. Used by the test suite. */
export class RecordingEmailSender implements EmailSender {
  public readonly sent: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }
}
