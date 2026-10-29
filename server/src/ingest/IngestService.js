// One entry point per inbound channel. Each turns its own format into raw order records,
// runs them through the shared pipeline, and produces the reply that channel expects.
import { parseMime } from './channels/mime.js';
import { emailToRecords, emailTimestamp, fillUnparseable } from './channels/email.js';
import { parseX12, ack997 } from './channels/edi.js';
import { composeEmailReply, apiOrderResult } from './reply.js';

export class IngestService {
  /** @param ai optional { extractEmail(text), minConfidence }: reads emails the rule-based parser cannot */
  constructor(pipeline, ai = null) { this.pipeline = pipeline; this.ai = ai; }

  async #complete(channel, { source, subject, raw, records, fallbackTs }, makeReply) {
    const { message, results } = await this.pipeline.run({ channel, source, subject, raw, records, fallbackTs });
    const reply = makeReply(results);
    await this.pipeline.finish(message.id, { status: message.status, summary: message.summary, reply });
    return { message_id: message.id, status: message.status, summary: message.summary, reply, orders: results.map(apiOrderResult) };
  }

  /** Raw RFC 822 email (.eml), as uploaded or dropped into the inbox folder. */
  email(raw, { filename } = {}) {
    const m = parseMime(raw);
    return this.parsedEmail({ from: m.from, subject: m.subject, date: m.date, text: m.text, attachments: m.attachments }, { raw, filename });
  }

  /** Already-parsed email, e.g. from an email provider's inbound webhook. */
  async parsedEmail(email, { raw, filename } = {}) {
    let records = emailToRecords({ ...email, text: email.text || '' });
    if (this.ai) records = await fillUnparseable(records, email.text || '', this.ai.extractEmail, this.ai.minConfidence);
    return this.#complete('Email', {
      source: email.from || filename, subject: email.subject, raw: raw ?? JSON.stringify(email),
      records, fallbackTs: emailTimestamp(email.date || ''),
    }, (results) => composeEmailReply({ to: email.from || '(unknown sender)', subject: email.subject, results }));
  }

  /** ANSI X12 850 file. */
  async edi(raw, { filename } = {}) {
    const parsed = parseX12(raw);
    if (!parsed.orders.length) {
      // Nothing usable in the envelope: one rejected placeholder so the file is answered with a 997 R.
      parsed.orders.push({ client_hint: parsed.sender, unparseable: true, structural_errors: parsed.envelope_errors, ship_to: {}, txn: '0001', source_ref: 'envelope' });
    }
    return this.#complete('EDI', { source: parsed.sender || filename, subject: filename, raw, records: parsed.orders },
      (results) => ack997(parsed, results.map((r, i) => ({ ...r, txn: parsed.orders[i].txn }))));
  }

  /** Orders posted by an authenticated API client. The client comes from the token, never the payload. */
  api(clientId, orders) {
    const records = orders.map((o, i) => ({
      client_hint: clientId,
      client_order_ref: o.client_order_ref ?? o.po_number,
      sku: o.sku,
      quantity: o.quantity,
      service: o.service ?? o.commitment_type,
      requested_date: o.requested_date,
      received_ts: o.received_at ? String(o.received_at).slice(0, 16) : undefined,
      ship_to: o.ship_to || {},
      source_ref: `orders[${i}]`,
    }));
    return this.#complete('API', { source: clientId, subject: `${orders.length} order(s)`, raw: JSON.stringify(orders), records }, () => null);
  }

  /** CSV batch file dropped by a client (file name must start with its client id, e.g. C055_orders.csv). */
  csvFile(raw, { filename }) {
    const client = filename.match(/^(C\d{3})[_-]/i)?.[1]?.toUpperCase() || '';
    const records = emailToRecords({ from: '', subject: filename, date: '', text: '', attachments: [{ filename, contentType: 'text/csv', content: raw }] })
      .map((r) => ({ ...r, client_hint: r.client_hint || client }));
    return this.#complete('File', { source: filename, subject: filename, raw, records },
      (results) => composeEmailReply({ to: `${client || 'unknown client'} (file drop)`, subject: filename, results }));
  }

  reprocess(orderId, patch) { return this.pipeline.reprocess(orderId, patch); }
}

