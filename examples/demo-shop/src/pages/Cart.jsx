import { Link, useNavigate } from 'react-router-dom';
import { useEffect } from 'react';
import { useCart } from '../cart.jsx';
import { money } from '../data.js';
import Plant from '../Plant.jsx';

export default function Cart() {
  const { lines, subtotal, setQty } = useCart();
  const navigate = useNavigate();
  useEffect(() => {
    document.title = 'Your basket — Fern & Co';
  }, []);
  if (!lines.length)
    return (
      <div className="empty">
        <h1>Your basket is empty</h1>
        <Link className="btn" to="/">
          Start shopping
        </Link>
      </div>
    );
  return (
    <>
      <h1>Your basket</h1>
      <table className="cart">
        <tbody>
          {lines.map((l) => (
            <tr key={l.id}>
              <td>
                <Plant color={l.product.color} size={56} label={l.product.name} />
              </td>
              <td>
                <Link to={`/p/${l.id}`}>{l.product.name}</Link>
              </td>
              <td>
                <div className="qty">
                  <button aria-label={`Decrease ${l.product.name}`} onClick={() => setQty(l.id, l.qty - 1)}>
                    −
                  </button>
                  <span>{l.qty}</span>
                  <button aria-label={`Increase ${l.product.name}`} onClick={() => setQty(l.id, l.qty + 1)}>
                    +
                  </button>
                </div>
              </td>
              <td className="right">{money(l.product.price * l.qty)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="cart-foot">
        <p>
          Subtotal <strong>{money(subtotal)}</strong>
        </p>
        <p className="muted small">Shipping and discounts are calculated at checkout.</p>
        <button className="btn" data-testid="checkout" onClick={() => navigate('/checkout')}>
          Checkout
        </button>
      </div>
    </>
  );
}
