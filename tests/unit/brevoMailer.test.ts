import http from 'node:http';
import { loadConfig } from '../../src/config/app.config';
import { IntegrationError } from '../../src/errors/app.errors';
import { BrevoEmailSender } from '../../src/integrations/brevoMailer.integration';
import { createEmailSender } from '../../src/integrations/emailSender.factory';
import { NodemailerEmailSender } from '../../src/integrations/mailer.integration';
import { silentLogger } from '../../src/utils/logger.util';

interface FakeBrevo {
  url: string;
  requests: { method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string }[];
  statuses: number[];
  close: () => Promise<void>;
}

/** A local server standing in for Brevo's API. Replies 201 unless a status has been queued. */
async function startFakeBrevo(): Promise<FakeBrevo> {
  const requests: FakeBrevo['requests'] = [];
  const statuses: number[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      const status = statuses.shift() ?? 201;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(status < 400 ? JSON.stringify({ messageId: '<1@brevo>' }) : JSON.stringify({ code: 'invalid_parameter', message: 'sender not valid: secret-detail' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    requests,
    statuses,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

describe('BrevoEmailSender', () => {
  let fake: FakeBrevo;
  const sender = (overrides: Partial<ConstructorParameters<typeof BrevoEmailSender>[0]> = {}): BrevoEmailSender =>
    new BrevoEmailSender({ apiKey: 'xkeysib-secret', senderEmail: 'me@gmail.com', senderName: 'Sentodo MFB', logger: silentLogger, apiUrl: fake.url, ...overrides });

  beforeEach(async () => {
    fake = await startFakeBrevo();
  });
  afterEach(async () => {
    await fake.close();
  });

  it('posts to /v3/smtp/email with the api-key header', async () => {
    await sender().send({ to: 'a@example.com', subject: 'Your code', text: 'Code 123456' });
    expect(fake.requests).toHaveLength(1);
    const [request] = fake.requests;
    expect(request.method).toBe('POST');
    expect(request.url).toBe('/v3/smtp/email');
    expect(request.headers['api-key']).toBe('xkeysib-secret');
    expect(request.headers['content-type']).toBe('application/json');
  });

  it('sends the verified sender, the recipient, the subject and a text body', async () => {
    await sender().send({ to: 'a@example.com', subject: 'Your code', text: 'Code 123456' });
    expect(JSON.parse(fake.requests[0].body)).toEqual({
      sender: { name: 'Sentodo MFB', email: 'me@gmail.com' },
      to: [{ email: 'a@example.com' }],
      subject: 'Your code',
      textContent: 'Code 123456',
    });
  });

  it('sends only the HTML body when one is supplied (Brevo allows one body type)', async () => {
    await sender().send({ to: 'a@example.com', subject: 'Hi', text: 'plain', html: '<b>rich</b>' });
    const payload = JSON.parse(fake.requests[0].body);
    expect(payload.htmlContent).toBe('<b>rich</b>');
    expect(payload).not.toHaveProperty('textContent');
  });

  it.each([400, 401, 403, 429, 500, 503])('throws an IntegrationError on HTTP %i so the queue can retry', async (status) => {
    fake.statuses.push(status);
    const error = await sender().send({ to: 'a@example.com', subject: 'Hi', text: 'x' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IntegrationError);
    expect((error as IntegrationError).message).toBe(`Unable to send email (HTTP ${status})`);
  });

  it('keeps Brevo error details and the API key out of the client-safe message', async () => {
    fake.statuses.push(400);
    const error = (await sender().send({ to: 'a@example.com', subject: 'Hi', text: 'x' }).catch((e: unknown) => e)) as IntegrationError;
    expect(error.message).not.toContain('secret-detail');
    expect(error.message).not.toContain('xkeysib-secret');
    expect(String((error as { cause?: Error }).cause?.message)).toContain('sender not valid');
  });

  it('throws an IntegrationError when Brevo cannot be reached', async () => {
    await expect(sender({ apiUrl: 'http://127.0.0.1:1', timeoutMs: 500 }).send({ to: 'a@example.com', subject: 'Hi', text: 'x' })).rejects.toBeInstanceOf(IntegrationError);
  });
});

describe('email provider configuration', () => {
  const base = {
    DATABASE_USER: 'x', DATABASE_PASSWORD: 'x', DATABASE_NAME: 'x', MONGODB_URI: 'mongodb://x', REDIS_URL: 'redis://x',
    JWT_SECRET: 'a'.repeat(20), ADMIN_SERVICE_TOKEN: 'b'.repeat(20),
  };
  const brevo = { BREVO_API_KEY: 'xkeysib-1', BREVO_SENDER_EMAIL: 'me@gmail.com' };

  it('defaults to SMTP and builds a Nodemailer sender', () => {
    const config = loadConfig(base);
    expect(config.emailProvider).toBe('smtp');
    expect(createEmailSender(config, silentLogger)).toBeInstanceOf(NodemailerEmailSender);
  });

  it('builds a Brevo sender when EMAIL_PROVIDER=brevo', () => {
    const config = loadConfig({ ...base, EMAIL_PROVIDER: 'brevo', ...brevo });
    expect(config.brevo).toEqual({ apiKey: 'xkeysib-1', senderEmail: 'me@gmail.com', senderName: 'Sentodo MFB' });
    expect(createEmailSender(config, silentLogger)).toBeInstanceOf(BrevoEmailSender);
  });

  it.each(Object.keys(brevo))('rejects EMAIL_PROVIDER=brevo without %s', (missing) => {
    const env: Record<string, string> = { ...base, EMAIL_PROVIDER: 'brevo', ...brevo };
    delete env[missing];
    expect(() => loadConfig(env)).toThrow(missing);
  });

  it('rejects a sender that is not an email address', () => {
    expect(() => loadConfig({ ...base, EMAIL_PROVIDER: 'brevo', ...brevo, BREVO_SENDER_EMAIL: 'not-an-email' })).toThrow('BREVO_SENDER_EMAIL');
  });

  it('does not require Brevo settings for SMTP', () => {
    expect(() => loadConfig({ ...base, EMAIL_PROVIDER: 'smtp' })).not.toThrow();
  });

  it('rejects an unknown provider (the old graph option is gone)', () => {
    expect(() => loadConfig({ ...base, EMAIL_PROVIDER: 'graph' })).toThrow('EMAIL_PROVIDER');
  });
});
