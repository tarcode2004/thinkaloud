import { useParams } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { categories, products } from '../data.js';
import ProductCard from './ProductCard.jsx';
import NotFound from './NotFound.jsx';

export default function Category() {
  const { slug } = useParams();
  const cat = categories.find((c) => c.slug === slug);
  const [sort, setSort] = useState('popular');
  useEffect(() => {
    if (cat) document.title = `${cat.name} — Fern & Co`;
  }, [cat]);
  if (!cat) return <NotFound />;
  let list = products.filter((p) => (slug === 'pet-friendly' ? p.petSafe && p.category !== 'accessories' : p.category === slug));
  if (sort === 'price-asc') list = [...list].sort((a, b) => a.price - b.price);
  if (sort === 'price-desc') list = [...list].sort((a, b) => b.price - a.price);
  return (
    <>
      <div className="list-head">
        <div>
          <h1>{cat.name}</h1>
          <p className="muted">{cat.blurb}</p>
        </div>
        <label className="sort">
          Sort by{' '}
          <select value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="popular">Most popular</option>
            <option value="price-asc">Price: low to high</option>
            <option value="price-desc">Price: high to low</option>
          </select>
        </label>
      </div>
      <p className="muted">{list.length} products</p>
      <div className="grid">
        {list.map((p) => (
          <ProductCard key={p.id} p={p} />
        ))}
      </div>
    </>
  );
}
