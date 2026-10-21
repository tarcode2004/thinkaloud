export const categories = [
  { slug: 'indoor', name: 'Indoor plants', blurb: 'Leafy friends for bright and shady rooms.' },
  { slug: 'succulents', name: 'Succulents & cacti', blurb: 'Low-water, high-charm.' },
  { slug: 'pet-friendly', name: 'Pet-friendly', blurb: 'Safe around cats and dogs.' },
  { slug: 'accessories', name: 'Pots & care', blurb: 'Planters, soil and tools.' },
];

export const products = [
  { id: 'monstera', name: 'Monstera Deliciosa', price: 39, category: 'indoor', color: '#3f7d58', light: 'Bright, indirect', water: 'Weekly', size: '60–70 cm', petSafe: false, description: 'The classic Swiss cheese plant. Fast-growing, dramatic split leaves and very forgiving.' },
  { id: 'snake', name: 'Snake Plant', price: 29, category: 'indoor', color: '#58764a', light: 'Low to bright', water: 'Every 2–3 weeks', size: '40–50 cm', petSafe: false, description: 'Upright sword-like leaves. Nearly impossible to kill and great for bedrooms.' },
  { id: 'pothos', name: 'Golden Pothos', price: 19, category: 'indoor', color: '#7fa34a', light: 'Low to bright', water: 'Weekly', size: 'Trailing, 30 cm pot', petSafe: false, description: 'Trailing vines with marbled leaves. Looks lovely on a shelf.' },
  { id: 'fiddle', name: 'Fiddle Leaf Fig', price: 59, category: 'indoor', color: '#2f6b4f', light: 'Bright, indirect', water: 'Weekly', size: '90–100 cm', petSafe: false, description: 'A statement tree with big violin-shaped leaves. Likes consistency.' },
  { id: 'echeveria', name: 'Echeveria Trio', price: 24, category: 'succulents', color: '#8fb3a0', light: 'Full sun', water: 'Every 2 weeks', size: '3 × 9 cm pots', petSafe: true, description: 'Three rosette succulents in soft blue-green tones.' },
  { id: 'aloe', name: 'Aloe Vera', price: 18, category: 'succulents', color: '#6f9a6a', light: 'Bright', water: 'Every 2–3 weeks', size: '30 cm', petSafe: false, description: 'Soothing gel-filled leaves; thrives on a sunny windowsill.' },
  { id: 'bunny', name: 'Bunny Ear Cactus', price: 21, category: 'succulents', color: '#9aae5e', light: 'Full sun', water: 'Monthly', size: '25 cm', petSafe: false, description: 'Paddle-shaped pads covered in soft-looking (but prickly!) dots.' },
  { id: 'calathea', name: 'Calathea Orbifolia', price: 34, category: 'pet-friendly', color: '#5d8d6e', light: 'Medium, indirect', water: 'Keep moist', size: '45 cm', petSafe: true, description: 'Huge round silver-striped leaves. Loves humidity.' },
  { id: 'spider', name: 'Spider Plant', price: 16, category: 'pet-friendly', color: '#86b37a', light: 'Bright, indirect', water: 'Weekly', size: '30 cm', petSafe: true, description: 'Arching striped leaves and baby plantlets you can propagate.' },
  { id: 'parlor', name: 'Parlor Palm', price: 32, category: 'pet-friendly', color: '#4f8a5b', light: 'Low to medium', water: 'Weekly', size: '50–60 cm', petSafe: true, description: 'A soft, feathery palm that tolerates low light.' },
  { id: 'terracotta', name: 'Terracotta Pot Set', price: 22, category: 'accessories', color: '#c5754d', light: '—', water: '—', size: '12, 15, 18 cm', petSafe: true, description: 'Three breathable classic clay pots with saucers.' },
  { id: 'soil', name: 'Aroid Soil Mix (5 L)', price: 12, category: 'accessories', color: '#7a5a43', light: '—', water: '—', size: '5 litres', petSafe: true, description: 'Chunky, airy mix for monsteras, philodendrons and friends.' },
];

export const shippingOptions = [
  { id: 'standard', label: 'Standard', detail: '3–5 working days', price: 4.95, freeOver: 50 },
  { id: 'express', label: 'Express', detail: 'Next working day if ordered before 2pm', price: 9.95 },
  { id: 'pickup', label: 'Click & collect', detail: 'Collect from our Bristol greenhouse', price: 0 },
];

export const PROMO_CODES = { FERN10: 0.1, GREENTHUMB: 0.15 };

export const money = (n) => `£${n.toFixed(2)}`;
export const productById = (id) => products.find((p) => p.id === id);
