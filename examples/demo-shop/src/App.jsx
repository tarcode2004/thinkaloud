import { Link, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { useEffect } from 'react';
import { useCart } from './cart.jsx';
import { categories } from './data.js';
import Home from './pages/Home.jsx';
import Category from './pages/Category.jsx';
import Product from './pages/Product.jsx';
import Cart from './pages/Cart.jsx';
import Checkout from './pages/Checkout.jsx';
import OrderComplete from './pages/OrderComplete.jsx';
import Returns from './pages/Returns.jsx';
import Help from './pages/Help.jsx';
import NotFound from './pages/NotFound.jsx';

function Header() {
  const { count } = useCart();
  return (
    <header className="header">
      <div className="wrap header-inner">
        <Link to="/" className="logo">
          <img src="/favicon.svg" alt="" width="28" height="28" /> Fern &amp; Co
        </Link>
        <nav className="nav">
          {categories.map((c) => (
            <NavLink key={c.slug} to={`/c/${c.slug}`}>
              {c.name}
            </NavLink>
          ))}
          <NavLink to="/help">Help</NavLink>
        </nav>
        <Link to="/cart" className="cart-link" data-testid="cart-link">
          Basket <span className="badge">{count}</span>
        </Link>
      </div>
    </header>
  );
}

function Footer() {
  // Deliberately dense, low-contrast footer: the Returns policy link is hard to spot.
  return (
    <footer className="footer">
      <div className="wrap footer-grid">
        <div>
          <strong>Fern &amp; Co</strong>
          <p>Independent plant shop since 2016. Unit 4, Greenhouse Lane, Bristol BS1 5XX.</p>
        </div>
        <div>
          <strong>Shop</strong>
          {categories.map((c) => (
            <Link key={c.slug} to={`/c/${c.slug}`}>
              {c.name}
            </Link>
          ))}
        </div>
        <div>
          <strong>Company</strong>
          <a>About us</a>
          <a>Careers</a>
          <a>Wholesale</a>
          <a>Press</a>
        </div>
      </div>
      <div className="wrap footer-legal">
        © 2026 Fern &amp; Co Ltd · Company no. 09876543 · VAT GB123456789 · <a>Terms</a> · <a>Privacy</a> · <a>Cookies</a> ·{' '}
        <Link to="/help/returns" className="legal-link">
          Returns policy
        </Link>{' '}
        · <a>Accessibility</a>
      </div>
    </footer>
  );
}

export default function App() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return (
    <div className="app">
      <Header />
      <main className="wrap main">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/c/:slug" element={<Category />} />
          <Route path="/p/:id" element={<Product />} />
          <Route path="/cart" element={<Cart />} />
          <Route path="/checkout" element={<Checkout />} />
          <Route path="/order/complete" element={<OrderComplete />} />
          <Route path="/help" element={<Help />} />
          <Route path="/help/returns" element={<Returns />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
      <Footer />
    </div>
  );
}
