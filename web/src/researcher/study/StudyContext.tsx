import { createContext, useContext } from 'react';
import type { StudyDetail } from '../lib.ts';

export interface StudyCtx {
  detail: StudyDetail;
  reload: () => Promise<unknown>;
  /** Optimistic local update. */
  update: (fn: (d: StudyDetail) => StudyDetail) => void;
}

export const StudyContext = createContext<StudyCtx | null>(null);

export function useStudy() {
  const c = useContext(StudyContext);
  if (!c) throw new Error('useStudy outside StudyLayout');
  return c;
}
