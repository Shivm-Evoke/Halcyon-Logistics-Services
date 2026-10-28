// Minimal RFC 5322 / MIME reader for inbound order emails: headers, encoded words,
// multipart bodies, quoted-printable and base64 parts, and attachments.

const unfold = (h) => h.replace(/\r?\n[ \t]+/g, ' ');

// =?utf-8?Q?..?= and =?utf-8?B?..?= in headers.
const decodeWords = (s) => s.replace(/=\?([^?]+)\?([QBqb])\?([^?]*)\?=/g, (_, _cs, enc, data) => (
  enc.toUpperCase() === 'B'
    ? Buffer.from(data, 'base64').toString('utf8')
    : decodeQP(data.replace(/_/g, ' '))));

function decodeQP(s) {
  const bytes = [];
  const text = s.replace(/=\r?\n/g, '');
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16)); i += 2;
    } else bytes.push(...Buffer.from(text[i], 'utf8'));
  }
  return Buffer.from(bytes).toString('utf8');
}

function parseHeaders(block) {
  const headers = {};
  for (const line of unfold(block).split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = decodeWords(line.slice(i + 1).trim());
  }
  return headers;
}

const param = (header = '', name) => header.match(new RegExp(`${name}\\*?=\\s*"?([^";]+)"?`, 'i'))?.[1];

function splitPart(raw) {
  const m = raw.match(/\r?\n\r?\n/);
  if (!m) return { headers: parseHeaders(raw), body: '' };
  return { headers: parseHeaders(raw.slice(0, m.index)), body: raw.slice(m.index + m[0].length) };
}

function decodeBody(body, encoding = '') {
  const e = encoding.toLowerCase();
  if (e === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  if (e === 'quoted-printable') return decodeQP(body);
  return body;
}

export const stripHtml = (html) => html
  .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
  .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

function walk(part, out) {
  const type = (part.headers['content-type'] || 'text/plain').toLowerCase();
  const boundary = param(part.headers['content-type'], 'boundary');
  if (type.startsWith('multipart/') && boundary) {
    const pieces = part.body.split(new RegExp(`\\r?\\n?--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?`));
    for (const p of pieces.slice(1)) if (p.trim()) walk(splitPart(p.replace(/^\r?\n/, '')), out);
    return;
  }
  const content = decodeBody(part.body, part.headers['content-transfer-encoding']);
  const filename = param(part.headers['content-disposition'], 'filename') || param(part.headers['content-type'], 'name');
  const isAttachment = /attachment/i.test(part.headers['content-disposition'] || '') || filename;
  if (isAttachment) out.attachments.push({ filename: filename || 'attachment', contentType: type.split(';')[0], content });
  else if (type.startsWith('text/html')) out.html.push(content);
  else if (type.startsWith('text/')) out.text.push(content);
}

export function parseMime(raw) {
  const root = splitPart(String(raw).replace(/^﻿/, ''));
  const out = { text: [], html: [], attachments: [] };
  walk(root, out);
  const text = out.text.join('\n').trim() || stripHtml(out.html.join('\n'));
  const fromHeader = root.headers.from || '';
  return {
    headers: root.headers,
    from: (fromHeader.match(/<([^>]+)>/)?.[1] || fromHeader).trim().toLowerCase(),
    subject: root.headers.subject || '',
    date: root.headers.date || '',
    text,
    attachments: out.attachments,
  };
}
