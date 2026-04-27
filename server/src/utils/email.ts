import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM = process.env.ALERT_FROM_EMAIL ?? 'gateway@noreply.com';
const TO = process.env.ALERT_TO_EMAIL ?? '';

interface AlertPayload {
    subject: string;
    message: string;
    kind: string;
    accountLabel?: string | null;
}

export async function sendAlert({ subject, message, kind, accountLabel }: AlertPayload): Promise<void> {
    if (!process.env.RESEND_API_KEY || !TO) {
        console.warn('[email] RESEND_API_KEY or ALERT_TO_EMAIL not set — skipping email');
        return;
    }

    const html = `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
      <h2 style="color:#dc2626">⚠️ Gateway Alert</h2>
      <table style="width:100%;border-collapse:collapse">
        <tr><td style="padding:8px;font-weight:bold">Kind</td><td style="padding:8px">${kind}</td></tr>
        ${accountLabel ? `<tr><td style="padding:8px;font-weight:bold">Account</td><td style="padding:8px">${accountLabel}</td></tr>` : ''}
        <tr><td style="padding:8px;font-weight:bold">Time</td><td style="padding:8px">${new Date().toISOString()}</td></tr>
        <tr><td style="padding:8px;font-weight:bold">Detail</td><td style="padding:8px">${message}</td></tr>
      </table>
      <p style="color:#6b7280;font-size:12px;margin-top:24px">Sent by your AI Gateway</p>
    </div>`;

    try {
        await resend.emails.send({ from: FROM, to: TO, subject, html });
    } catch (err: unknown) {
        console.error('[email] Failed to send alert:', (err as Error).message);
    }
}
