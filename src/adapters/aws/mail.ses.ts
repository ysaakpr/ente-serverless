/** SES (v1 API — LocalStack community supports it) implementation of Mail. */

import { SendEmailCommand } from '@aws-sdk/client-ses';
import type { Mail, MailMessage } from '../../ports/mail.ts';
import type { Config } from '../../config.ts';
import { getSesClient } from './clients.ts';

export class SesMail implements Mail {
  constructor(private config: Config) {}

  async send(message: MailMessage): Promise<void> {
    await getSesClient(this.config).send(
      new SendEmailCommand({
        Source: `${message.fromName} <${message.from}>`,
        Destination: { ToAddresses: [message.to] },
        Message: {
          Subject: { Data: message.subject },
          Body: {
            Html: {
              Data: `<p>Verification code: <b>${
                (message.templateData as { VerificationCode?: string }).VerificationCode ?? ''
              }</b></p>`,
            },
          },
        },
      }),
    );
  }
}
