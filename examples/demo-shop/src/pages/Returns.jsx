import { useEffect } from 'react';

export default function Returns() {
  useEffect(() => {
    document.title = 'Returns policy — Fern & Co';
  }, []);
  return (
    <article className="prose">
      <h1>Returns policy</h1>
      <p>
        If your plant arrives damaged or unhealthy, tell us within <strong>30 days</strong> and we will replace it or refund you in full.
      </p>
      <p>Unwanted accessories can be returned unused within 14 days. Live plants cannot be returned simply because you changed your mind.</p>
      <p>To start a return, email care@fernandco.example with your order number and a photo.</p>
    </article>
  );
}
