/**
 * prefers-reduced-motion 支持（accessible-animation 分级降级）。
 * 分级：Tier1 移除（粒子/相机飞行/大幅位移）、Tier2 弱化（短淡入）、Tier3 保留（透明度/颜色）。
 */
import { useEffect, useState } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia && window.matchMedia(QUERY).matches;
}

/** React hook：监听系统设置的实时变化 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.matchMedia(QUERY).matches : false,
  );
  useEffect(() => {
    const mq = window.matchMedia(QUERY);
    const onChange = () => setReduced(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}
