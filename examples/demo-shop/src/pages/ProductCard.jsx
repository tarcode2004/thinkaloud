import { Link } from 'react-router-dom';
import Plant from '../Plant.jsx';
import { money } from '../data.js';

export default function ProductCard({ p }) {
  return (
    <Link to={`/p/${p.id}`} className="card" data-testid={`product-${p.id}`}>
      <Plant color={p.color} label={p.name} size={180} />
      <div className="card-body">
        <span className="card-name">{p.name}</span>
        <span className="price">{money(p.price)}</span>
        {p.petSafe && <span className="tag">Pet-safe</span>}
      </div>
    </Link>
  );
}
