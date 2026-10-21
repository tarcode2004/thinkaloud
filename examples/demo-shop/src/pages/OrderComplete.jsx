import { Link } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { money } from '../data.js';

export default function OrderComplete() {
  const [order] = useState(() => {
    try {
      return JSON.parse(sessionStorage.getItem('fern-last-order') || 'null');
    } catch {
      return null;
    }
  });
  useEffect(() => {
    document.title = 'Order confirmed — Fern & Co';
  }, []);
  return (
    <div className="empty" id="order-complete">
      <h1>Thank you — your order is confirmed</h1>
      {order ? (
        <p>
          Order <strong data-testid="order-number">{order.number}</strong> · {order.items} item(s) · {money(order.total)} · {order.shipping}
        </p>
      ) : (
        <p>We have emailed you a confirmation.</p>
      )}
      <Link className="btn" to="/">
        Continue shopping
      </Link>
    </div>
  );
}
