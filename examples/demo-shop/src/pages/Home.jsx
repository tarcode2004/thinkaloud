import { Link } from 'react-router-dom';
import { useEffect } from 'react';
import { categories, products } from '../data.js';
import ProductCard from './ProductCard.jsx';

export default function Home() {
  useEffect(() => {
    document.title = 'Fern & Co — Plants for every room';
  }, []);
  return (
    <>
      <section className="hero">
        <div>
          <h1>Plants for every room</h1>
          <p>Healthy, nursery-grown plants delivered in plastic-free packaging. Free standard delivery over £50.</p>
          <Link className="btn" to="/c/indoor">
            Shop indoor plants
          </Link>
        </div>
      </section>
      <h2>Shop by category</h2>
      <div className="cat-grid">
        {categories.map((c) => (
          <Link key={c.slug} to={`/c/${c.slug}`} className="cat-card">
            <strong>{c.name}</strong>
            <span>{c.blurb}</span>
          </Link>
        ))}
      </div>
      <h2>Bestsellers</h2>
      <div className="grid">
        {products.slice(0, 4).map((p) => (
          <ProductCard key={p.id} p={p} />
        ))}
      </div>
    </>
  );
}
