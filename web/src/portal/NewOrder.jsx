// Place one order; it goes through the same checks as email, file and API orders.
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Send } from 'lucide-react';
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

export default function NewOrder() {
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
      <PageHead title="New order" eyebrow="Place an order">
        We check every order as it arrives. If something needs fixing we hold it and tell you what, instead of shipping a mistake.
      </PageHead>
      <form className="card section-gap" onSubmit={submit}>
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
      </form>
    </>
  );
}
