import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { productById } from './data.js';

const CartContext = createContext(null);
const KEY = 'fern-cart-v1';

function load() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '[]');
  } catch {
    return [];
  }
}

export function CartProvider({ children }) {
  const [items, setItems] = useState(load);
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(items));
    } catch {
      /* storage blocked */
    }
  }, [items]);

  const api = useMemo(() => {
    const lines = items.map((i) => ({ ...i, product: productById(i.id) })).filter((l) => l.product);
    const subtotal = lines.reduce((s, l) => s + l.product.price * l.qty, 0);
    return {
      lines,
      count: lines.reduce((s, l) => s + l.qty, 0),
      subtotal,
      add: (id, qty = 1) =>
        setItems((cur) => (cur.some((i) => i.id === id) ? cur.map((i) => (i.id === id ? { ...i, qty: i.qty + qty } : i)) : [...cur, { id, qty }])),
      setQty: (id, qty) => setItems((cur) => (qty <= 0 ? cur.filter((i) => i.id !== id) : cur.map((i) => (i.id === id ? { ...i, qty } : i)))),
      clear: () => setItems([]),
    };
  }, [items]);
  return <CartContext.Provider value={api}>{children}</CartContext.Provider>;
}

export const useCart = () => useContext(CartContext);
