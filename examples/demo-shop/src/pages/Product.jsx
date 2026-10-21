import { Link, useParams } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { categories, money, productById } from '../data.js';
import { useCart } from '../cart.jsx';
import Plant from '../Plant.jsx';
import NotFound from './NotFound.jsx';
import { track } from '../track.js';

export default function Product() {
  const { id } = useParams();
  const p = productById(id);
  const { add } = useCart();
  const [qty, setQty] = useState(1);
  const [added, setAdded] = useState(false);
  useEffect(() => {
    if (p) document.title = `${p.name} — Fern & Co`;
  }, [p]);
  if (!p) return <NotFound />;
  const cat = categories.find((c) => c.slug === p.category);
  return (
    <>
      <p className="crumbs">
        <Link to="/">Home</Link> / <Link to={`/c/${p.category}`}>{cat?.name}</Link> / {p.name}
      </p>
      <div className="pdp">
        <Plant color={p.color} label={p.name} size={360} />
        <div>
          <h1>{p.name}</h1>
          <p className="price big">{money(p.price)}</p>
          <p>{p.description}</p>
          <dl className="specs">
            <dt>Light</dt>
            <dd>{p.light}</dd>
            <dt>Water</dt>
            <dd>{p.water}</dd>
            <dt>Size</dt>
            <dd>{p.size}</dd>
            <dt>Pet-safe</dt>
            <dd>{p.petSafe ? 'Yes' : 'No — keep away from pets'}</dd>
          </dl>
          <div className="buy">
            <label>
              Qty{' '}
              <input type="number" min="1" max="20" value={qty} onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))} />
            </label>
            <button
              className="btn"
              data-testid="add-to-cart"
              onClick={() => {
                add(p.id, qty);
                setAdded(true);
                track('add_to_cart', { productId: p.id, qty });
              }}
            >
              Add to basket
            </button>
          </div>
          {added && (
            <p className="notice">
              Added to your basket. <Link to="/cart">View basket</Link>
            </p>
          )}
          <p className="muted small">Delivered in 3–5 working days. 30-day happy plant guarantee.</p>
        </div>
      </div>
    </>
  );
}
