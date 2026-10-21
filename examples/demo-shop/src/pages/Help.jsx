import { useEffect } from 'react';

export default function Help() {
  useEffect(() => {
    document.title = 'Help — Fern & Co';
  }, []);
  return (
    <article className="prose">
      <h1>Help &amp; plant care</h1>
      <h2>Watering</h2>
      <p>Most of our plants prefer to dry out slightly between waterings. Check the top 2 cm of soil with your finger.</p>
      <h2>Delivery</h2>
      <p>Standard delivery takes 3–5 working days and is free over £50. Express orders placed before 2pm arrive the next working day.</p>
      <h2>Contact</h2>
      <p>Email care@fernandco.example — we reply within one working day.</p>
    </article>
  );
}
