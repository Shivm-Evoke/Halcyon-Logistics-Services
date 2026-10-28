// What goes back to the client: a plain-English email reply, or a structured API response.

const LABEL = { accepted: 'Accepted', corrected: 'Accepted after automatic corrections', held: 'On hold: needs your correction', rejected: 'Rejected', duplicate: 'Duplicate: already received' };
const ORDER = ['held', 'rejected', 'duplicate', 'corrected', 'accepted'];
const name = (r, i) => `${r.ref} · line ${r.source_ref || i + 1}${r.client_order_ref ? ` · PO ${r.client_order_ref}` : ''}`;

export function composeEmailReply({ to, subject, results }) {
  const lines = [
    `To: ${to}`,
    `Subject: Re: ${subject || 'your order'} — ${results.length} order(s) received`,
    '',
    'Hello,',
    '',
    `Thank you for your order email. We read ${results.length} order(s) from it:`,
  ];
  for (const status of ORDER) {
    const group = results.map((r, i) => [r, i]).filter(([r]) => r.status === status);
    if (!group.length) continue;
    lines.push('', `${LABEL[status]} (${group.length})`);
    for (const [r, i] of group) {
      lines.push(`  • ${name(r, i)}`);
      if (r.promised_date) lines.push(`      Delivery promised ${r.promised_date} (${r.commitment_type.replace('_', '-')}), carrier ${r.carrier_id}`);
      for (const c of r.corrections.filter((x) => x.rule !== 'formatting')) lines.push(`      We changed ${c.field} from "${c.from}" to "${c.to}" (${c.rule})`);
      for (const iss of r.issues.filter((x) => x.severity !== 'warning' || ['same_day_after_cutoff', 'unknown_service', 'client_mismatch'].includes(x.code))) {
        lines.push(`      ${iss.severity === 'warning' ? 'Note' : 'Please fix'}: ${iss.message}${iss.suggestion ? ` (${iss.suggestion})` : ''}`);
      }
    }
  }
  if (results.some((r) => r.status === 'held')) {
    lines.push('', 'Orders on hold will ship as soon as you reply with the corrected details, or correct them through the order API.');
  }
  lines.push('', 'Halcyon Logistics · Order intake (automated)');
  return lines.join('\n');
}

export function apiOrderResult(r) {
  return {
    ref: r.ref,
    line: r.source_ref,
    client_order_ref: r.client_order_ref,
    status: r.status,
    promised_date: r.promised_date,
    commitment_type: r.commitment_type,
    carrier_id: r.carrier_id,
    late_risk: r.risk == null ? null : Number(r.risk.toFixed(3)),
    risk_drivers: r.drivers,
    corrections: r.corrections.filter((c) => c.rule !== 'formatting').map(({ field, from, to, rule }) => ({ field, from, to, rule })),
    issues: r.issues,
  };
}

