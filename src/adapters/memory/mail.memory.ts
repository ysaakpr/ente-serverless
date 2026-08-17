/** Mail spy — unit tests assert on sent mail (OTT delivery, notifications). */

import type { Mail, MailMessage } from '../../ports/mail.ts';

export class MemoryMail implements Mail {
  sent: MailMessage[] = [];

  async send(message: MailMessage): Promise<void> {
    this.sent.push(message);
  }
}
