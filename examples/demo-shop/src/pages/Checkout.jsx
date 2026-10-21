import { Link, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { useCart } from '../cart.jsx';
import { PROMO_CODES, money, shippingOptions } from '../data.js';
import { track } from '../track.js';

const REQUIRED = ['name', 'email', 'address', 'city', 'postcode', 'card', 'expiry', 'cvc'];

export default function Checkout() {
  const { lines, subtotal, clear } = useCart();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: '', email: '', address: '', city: '', postcode: '', country: 'GB', ref: '', card: '', expiry: '', cvc: '' });
  const [shipping, setShipping] = useState('standard');
  const [discount, setDiscount] = useState(0);
  const [refMsg, setRefMsg] = useState('');
  const [errors, setErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    document.title = 'Checkout — Fern & Co';
  }, []);

  if (!lines.length)
    return (
      <div className="empty">
        <h1>Nothing to check out</h1>
        <Link to="/">Back to the shop</Link>
      </div>
    );

  const opt = shippingOptions.find((o) => o.id === shipping);
  const shippingCost = opt.freeOver && subtotal >= opt.freeOver ? 0 : opt.price;
  const discountAmt = Math.round(subtotal * discount * 100) / 100;
  const total = subtotal - discountAmt + shippingCost;
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  // Deliberately confusing: labelled "Reference code", case-sensitive, icon-only apply
  // button, and success is only reflected as an "Adjustment" line in the summary.
  const applyRef = () => {
    const rate = PROMO_CODES[form.ref.trim()];
    if (rate) {
      setDiscount(rate);
      setRefMsg('');
      track('promo_applied', { ok: true });
    } else {
      setDiscount(0);
      setRefMsg('Reference not recognised.');
      track('promo_applied', { ok: false });
    }
  };

  const submit = (e) => {
    e.preventDefault();
    const errs = {};
    for (const k of REQUIRED) if (!form[k].trim()) errs[k] = 'Required';
    if (form.email && !/^\S+@\S+\.\S+$/.test(form.email)) errs.email = 'Enter a valid email';
    if (form.card && form.card.replace(/\s/g, '').length < 12) errs.card = 'Card number looks too short';
    setErrors(errs);
    if (Object.keys(errs).length) {
      track('checkout_validation_error', { fields: Object.keys(errs) });
      return;
    }
    setSubmitting(true);
    setTimeout(() => {
      const order = { number: 'FC-' + Math.floor(100000 + Math.random() * 900000), total, shipping: opt.label, items: lines.length };
      sessionStorage.setItem('fern-last-order', JSON.stringify(order));
      clear();
      track('order_complete', { total, shipping, discount: discount > 0 });
      navigate('/order/complete');
    }, 600);
  };

  const field = (k, label, props = {}) => (
    <label className={'field' + (errors[k] ? ' has-error' : '')}>
      <span>{label}</span>
      <input name={k} value={form[k]} onChange={set(k)} {...props} />
      {errors[k] && <em className="error">{errors[k]}</em>}
    </label>
  );

  return (
    <form className="checkout" onSubmit={submit} noValidate>
      <div>
        <h1>Checkout</h1>
        <fieldset>
          <legend>Contact</legend>
          {field('name', 'Full name', { autoComplete: 'name' })}
          {field('email', 'Email', { type: 'email', autoComplete: 'email' })}
        </fieldset>
        <fieldset>
          <legend>Delivery address</legend>
          {field('address', 'Address', { autoComplete: 'street-address' })}
          <div className="row">
            {field('city', 'Town / city', { autoComplete: 'address-level2' })}
            {field('postcode', 'Postcode', { autoComplete: 'postal-code' })}
          </div>
          <label className="field">
            <span>Country</span>
            <select name="country" value={form.country} onChange={set('country')}>
              <option value="GB">United Kingdom</option>
              <option value="IE">Ireland</option>
            </select>
          </label>
          <div className="ref-row">
            <label className="field">
              <span>Reference code (optional)</span>
              <input name="ref" value={form.ref} onChange={set('ref')} placeholder="" />
            </label>
            <button type="button" className="icon-btn" title="Apply" onClick={applyRef}>
              ↻
            </button>
          </div>
          {refMsg && <p className="error small">{refMsg}</p>}
        </fieldset>
        <fieldset>
          <legend>Delivery method</legend>
          {shippingOptions.map((o) => (
            <label key={o.id} className={'ship' + (shipping === o.id ? ' selected' : '')}>
              <input type="radio" name="shipping" value={o.id} checked={shipping === o.id} onChange={() => setShipping(o.id)} />
              <span>
                <strong>{o.label}</strong> — {o.detail}
              </span>
              <span className="right">{o.freeOver && subtotal >= o.freeOver ? 'Free' : o.price ? money(o.price) : 'Free'}</span>
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend>Payment</legend>
          <p className="muted small">Demo shop — please do not enter real card details. Any 12+ digits work.</p>
          {field('card', 'Card number', { inputMode: 'numeric', autoComplete: 'cc-number' })}
          <div className="row">
            {field('expiry', 'Expiry (MM/YY)', { autoComplete: 'cc-exp' })}
            {field('cvc', 'CVC', { inputMode: 'numeric', autoComplete: 'cc-csc' })}
          </div>
        </fieldset>
      </div>
      <aside className="summary">
        <h2>Order summary</h2>
        {lines.map((l) => (
          <p key={l.id} className="sum-line">
            <span>
              {l.qty} × {l.product.name}
            </span>
            <span>{money(l.product.price * l.qty)}</span>
          </p>
        ))}
        <p className="sum-line">
          <span>Delivery</span>
          <span>{shippingCost ? money(shippingCost) : 'Free'}</span>
        </p>
        {discountAmt > 0 && (
          <p className="sum-line">
            <span>Adjustment</span>
            <span>−{money(discountAmt)}</span>
          </p>
        )}
        <p className="sum-line total">
          <span>Total</span>
          <span>{money(total)}</span>
        </p>
        <button className="btn wide" type="submit" disabled={submitting} data-testid="place-order">
          {submitting ? 'Placing order…' : 'Place order'}
        </button>
      </aside>
    </form>
  );
}
