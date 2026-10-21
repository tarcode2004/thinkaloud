import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { CheckCircle2, AlertTriangle, Info } from 'lucide-react';

type Tone = 'success' | 'error' | 'info';
interface Toast { id: number; text: string; tone: Tone }
const Ctx = createContext<(text: string, tone?: Tone) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: Tone = 'success') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);
  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex flex-col gap-2">
        {toasts.map((t) => (
          <div key={t.id} className="pointer-events-auto flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2.5 text-sm text-white shadow-lg">
            {t.tone === 'success' ? <CheckCircle2 className="size-4 text-emerald-400" /> : t.tone === 'error' ? <AlertTriangle className="size-4 text-rose-400" /> : <Info className="size-4 text-sky-400" />}
            {t.text}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

/** const toast = useToast(); toast('Saved'); toast('Failed', 'error') */
export const useToast = () => useContext(Ctx);
