// Place one order; it goes through the same checks as email, file and API orders.
import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Send, UploadCloud, KeyRound, Copy, FlaskConical } from 'lucide-react';
import { api } from '../api.js';
import { PageHead } from '../components/ui.jsx';

const SERVICES = [['next day', 'Next day'], ['same day', 'Same day'], ['2-day', 'Two day'], ['standard', 'Standard']];
const EMPTY = { sku: '', quantity: '1', service: 'next day', client_order_ref: '', ship_to: { name: '', street: '', city: '', state: '', zip: '' } };

export function AddressFields({ value, onChange, issues = [] }) {
  const set = (k) => (e) => onChange({ ...value, [k]: e.target.value });
  const note = (k) => issues.filter((i) => i.field === `ship_to.${k}` || (k === 'street' && i.field === 'ship_to')).map((i) => i.message).join(' ');
  return (
    <div className="form-grid">
      {[['name', 'Recipient'], ['street', 'Street'], ['city', 'City'], ['state', 'State'], ['zip', 'ZIP code']].map(([k, label]) => (
        <label key={k} className={`field${k === 'street' || k === 'name' ? ' wide' : ''}`}><span>{label}</span>
          <input className="input" name={`ship_to.${k}`} value={value[k] || ''} onChange={set(k)} />
          {note(k) && <small className="field-error">{note(k)}</small>}
        </label>
      ))}
    </div>
  );
}


const TABS = [['form', 'Form'], ['edi', 'Upload EDI'], ['email', 'Send email'], ['api', 'API']];
const CHANNEL = { email: 'email', edi: 'EDI file', api: 'API', form: 'form' };

// After any send: each new order, linked to its tracking page.
function Sent({ sent }) {
  if (!sent) return null;
  const { orders, channel } = sent;
  return (
    <div className="callout good section-gap" role="status">
      <div>
        <b>{orders.length === 1 ? 'We received 1 order' : `We received ${orders.length} orders`}{channel ? ` by ${CHANNEL[channel] || channel}` : ''}.</b>
        <ul className="small">
          {orders.map((o, i) => (
            <li key={o.ref || i}>{o.ref ? <Link to={`/portal/shipments/${o.ref}`}>{o.ref}</Link> : 'Order'}{o.status ? ` · ${String(o.status).replace(/_/g, ' ')}` : ''}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// Sends one of the sample orders (n is the list of sample numbers for this channel) and reports the result.
function SampleButton({ n, onSent, onError, busy, setBusy }) {
  const send = async () => {
    setBusy(true); onError('');
    try {
      const results = [];
      for (const k of n) results.push(await api(`/portal/samples/${k}`, { method: 'POST' }));
      onSent({ channel: results[0].channel, orders: results.flatMap((r) => r.orders) });
    } catch (err) { onError(err.message); } finally { setBusy(false); }
  };
  return <button className="btn" type="button" onClick={send} disabled={busy}><FlaskConical size={15} /> {busy ? 'Sending…' : 'Send a sample'}</button>;
}

// A file drop that fills a text box; the text is what gets sent.
function TextSend({ path, noun, accept, hint, samples, onSent, onError, busy, setBusy }) {
  const [text, setText] = useState('');
  const [file, setFile] = useState(null);
  const [over, setOver] = useState(false);
  const input = useRef(null);
  const pick = async (f) => { if (!f) return; setFile(f); setText(await f.text()); };
  const send = async () => {
    setBusy(true); onError('');
    try {
      const r = await api(path, { method: 'POST', text });
      onSent({ orders: r.orders });
      setText(''); setFile(null);
    } catch (err) { onError(err.message); } finally { setBusy(false); }
  };
  return (
    <div className="card stack">
      <div className={`dropzone${over ? ' over' : ''}`} role="button" tabIndex={0}
        onClick={() => input.current?.click()} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); pick(e.dataTransfer.files?.[0]); }}>
        <UploadCloud size={28} />
        <div><b>{file ? file.name : `Drop ${noun} here`}</b></div>
        <div className="small muted">{hint}</div>
        <input ref={input} type="file" accept={accept} hidden onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />
      </div>
      <label className="field"><span>Or paste it here</span>
        <textarea className="input" rows={8} value={text} onChange={(e) => { setText(e.target.value); setFile(null); }} spellCheck={false} />
      </label>
      <div className="row" style={{ gap: 8 }}>
        <button className="btn primary" type="button" onClick={send} disabled={busy || !text.trim()}><Send size={15} /> {busy ? 'Sending…' : 'Send'}</button>
        <SampleButton n={samples} onSent={onSent} onError={onError} busy={busy} setBusy={setBusy} />
      </div>
    </div>
  );
}

function ApiTab({ sample }) {
  const [key, setKey] = useState(null);
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyError, setKeyError] = useState('');
  const [copied, setCopied] = useState('');
  const create = async () => {
    setKeyBusy(true); setKeyError('');
    try { setKey(await api('/portal/api-key', { method: 'POST' })); } catch (err) { setKeyError(err.message); } finally { setKeyBusy(false); }
  };
  const copy = async (what, v) => { try { await navigator.clipboard.writeText(v); setCopied(what); } catch { setCopied(''); } };
  const base = window.location.origin;
  return (
    <div className="card stack">
      <p className="small muted">Send orders straight from your own systems. Sign in with your API key to get a token, then post your orders.</p>
      <div className="small"><span className="muted">Base URL</span> <code className="mono">{base}/api</code></div>
      <div className="small"><a href="/api/docs" target="_blank" rel="noreferrer">Read the API documentation</a></div>
      <div>
        <button className="btn" type="button" onClick={create} disabled={keyBusy}><KeyRound size={15} /> {keyBusy ? 'Creating…' : 'Create API key'}</button>
        <span className="small muted"> Creating a new key stops the old one working.</span>
      </div>
      {keyError && <div className="callout bad small" role="alert">{keyError}</div>}
      {key && (
        <div className="callout warn small" role="status">
          <div className="stack">
            <b>Copy your secret now. We won't show it again.</b>
            <div>Client ID <code className="mono">{key.client_id}</code> <button className="btn sm" type="button" onClick={() => copy('id', key.client_id)}><Copy size={13} /> {copied === 'id' ? 'Copied' : 'Copy'}</button></div>
            <div>Secret <code className="mono" data-testid="api-secret">{key.secret}</code> <button className="btn sm" type="button" onClick={() => copy('secret', key.secret)}><Copy size={13} /> {copied === 'secret' ? 'Copied' : 'Copy'}</button></div>
            <div>Get a token at <code className="mono">{base}{key.token_url}</code></div>
          </div>
        </div>
      )}
      <div><SampleButton n={[3, 5]} {...sample} /></div>
    </div>
  );
}

function OrderForm({ sample }) {
  const navigate = useNavigate();
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const r = await api('/portal/orders', { method: 'POST', body: { ...form, quantity: Number(form.quantity) } });
      navigate(`/portal/shipments/${r.ref}`, { state: { justPlaced: true } });
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  return (
    <>
      <form className="card" onSubmit={submit}>
        <div className="form-grid">
          <label className="field"><span>Item code (SKU)</span><input className="input" name="sku" placeholder="e.g. HX-2201" value={form.sku} onChange={set('sku')} required /></label>
          <label className="field"><span>Quantity</span><input className="input" name="quantity" type="number" min="1" value={form.quantity} onChange={set('quantity')} required /></label>
          <label className="field"><span>Service</span>
            <select className="input" name="service" value={form.service} onChange={set('service')}>{SERVICES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          </label>
          <label className="field"><span>Your reference (optional)</span><input className="input" name="client_order_ref" placeholder="e.g. PO-1042" value={form.client_order_ref} onChange={set('client_order_ref')} /></label>
        </div>
        <h3 className="form-section">Deliver to</h3>
        <AddressFields value={form.ship_to} onChange={(ship_to) => setForm({ ...form, ship_to })} />
        {error && <div className="callout bad small" role="alert">{error}</div>}
        <button className="btn primary" type="submit" disabled={busy}><Send size={15} /> {busy ? 'Placing order…' : 'Place order'}</button>
        <SampleButton n={[4]} {...sample} />
      </form>
    </>
  );
}

export default function NewOrder() {
  const [tab, setTab] = useState('form');
  const [sent, setSent] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const sample = { onSent: setSent, onError: setError, busy, setBusy };
  const change = (t) => { setTab(t); setSent(null); setError(''); };
  return (
    <>
      <PageHead title="Place orders" eyebrow="Four ways to send us an order">
        However an order reaches us, we check it the same way. If something needs fixing we hold it and tell you what, instead of shipping a mistake.
      </PageHead>
      <div className="seg section-gap" role="tablist" aria-label="How to place orders">
        {TABS.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => change(k)}>{l}</button>)}
      </div>
      <div className="section-gap">
        {tab === 'form' && <OrderForm sample={sample} />}
        {tab === 'edi' && <TextSend path="/portal/edi" noun="an EDI file (X12 850)" accept=".edi,.x12,.txt,text/plain" hint="or click to choose one" samples={[2]} {...sample} />}
        {tab === 'email' && <TextSend path="/portal/email" noun="an email file (.eml)" accept=".eml,message/rfc822,text/plain" hint="or click to choose one, or paste the email below" samples={[1]} {...sample} />}
        {tab === 'api' && <ApiTab sample={sample} />}
      </div>
      {error && <div className="callout bad small section-gap" role="alert">{error}</div>}
      <Sent sent={sent} />
    </>
  );
}
