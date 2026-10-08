/** 实验台快照 hook */
import { useSyncExternalStore } from 'react';
import { lab, type LabSnapshot } from './lab';

export function useLabSnapshot(): LabSnapshot {
  const engine = lab();
  return useSyncExternalStore(engine.subscribe, engine.getSnapshot);
}
