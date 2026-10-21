// Illustrated plant "photo" (no external images needed).
export default function Plant({ color, size = 160, label }) {
  return (
    <svg className="plant" width={size} height={size} viewBox="0 0 100 100" role="img" aria-label={label}>
      <rect width="100" height="100" rx="10" fill="#f1efe8" />
      <path d="M50 70 C50 45 35 30 22 28 C24 45 34 60 50 70Z" fill={color} />
      <path d="M50 70 C50 40 62 22 80 18 C78 42 66 60 50 70Z" fill={color} opacity="0.85" />
      <path d="M50 72 C48 55 50 40 52 30" stroke="#2c4a35" strokeWidth="2" fill="none" />
      <path d="M32 70 h36 l-5 22 h-26z" fill="#c5754d" />
      <rect x="30" y="66" width="40" height="7" rx="2" fill="#b0623d" />
    </svg>
  );
}
