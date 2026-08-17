/** Mail port — SES in cloud, spy in unit tests, LocalStack SES in integration. */

export interface MailMessage {
  to: string;
  from: string;
  fromName: string;
  subject: string;
  templateName: string;
  templateData: Record<string, unknown>;
}

export interface Mail {
  send(message: MailMessage): Promise<void>;
}
