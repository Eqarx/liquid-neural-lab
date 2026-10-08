/**
 * 可拖动浮窗（玻璃质感）。桌面端可拖动、可折叠、位置记忆；窄屏自动变成底部面板。
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { onUiReset } from '../state/uiReset';

export interface PanelPos {
  x: number;
  y: number;
}

const POS_KEY = 'digitlab-v2-panel-pos';

function loadPositions(): Record<string, PanelPos> {
  try {
    const raw = localStorage.getItem(POS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, PanelPos>) : {};
  } catch {
    return {};
  }
}

function savePosition(id: string, pos: PanelPos) {
  try {
    const all = loadPositions();
    all[id] = pos;
    localStorage.setItem(POS_KEY, JSON.stringify(all));
  } catch {
    /* ignore */
  }
}

export function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 899px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 899px)');
    const onChange = () => setMobile(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return mobile;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export interface FloatingPanelProps {
  id: string;
  title: string;
  children: ReactNode;
  /** 默认位置（未拖动过时使用） */
  defaultPos?: { left?: number; right?: number; top?: number; bottom?: number };
  width?: number;
  onClose?: () => void;
  collapsible?: boolean;
  tone?: 'default' | 'warm' | 'cool';
}

export function FloatingPanel({
  id,
  title,
  children,
  defaultPos = { left: 24, top: 96 },
  width = 290,
  onClose,
  collapsible = true,
  tone = 'default',
}: FloatingPanelProps) {
  const isMobile = useIsMobile();
  const ref = useRef<HTMLElement>(null);
  const [pos, setPos] = useState<PanelPos | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [resetTick, setResetTick] = useState(0);
  const posRef = useRef<PanelPos | null>(null);

  // 全局复位：丢掉记忆位置、展开折叠，回到默认落位
  // （位置由下面的 layout effect 统一计算，这里只改 resetTick 触发它）
  useEffect(() => onUiReset(() => setResetTick((v) => v + 1)), []);
  useEffect(() => {
    if (resetTick === 0) return;
    setCollapsed(false);
  }, [resetTick]);

  // 初始位置：记忆值优先，否则按 defaultPos 计算
  useLayoutEffect(() => {
    if (isMobile) return;
    const stored = resetTick === 0 ? loadPositions()[id] : undefined;
    if (stored) {
      setPos(stored);
      posRef.current = stored;
      return;
    }
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = defaultPos.left !== undefined ? defaultPos.left : defaultPos.right !== undefined ? window.innerWidth - r.width - defaultPos.right : 24;
    const y = defaultPos.top !== undefined ? defaultPos.top : defaultPos.bottom !== undefined ? window.innerHeight - r.height - defaultPos.bottom : 96;
    const p = { x: clamp(x, 6, window.innerWidth - r.width - 6), y: clamp(y, 6, window.innerHeight - r.height - 6) };
    setPos(p);
    posRef.current = p;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMobile, id, resetTick]);

  /**
   * 拖拽：在 window 上跟踪指针（不依赖 pointer capture，避免指针离开元素后丢事件）。
   */
  const onDown = (e: React.PointerEvent) => {
    if (isMobile) return;
    const el = ref.current;
    if (!el) return;
    e.preventDefault();
    const r = el.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const originX = r.left;
    const originY = r.top;
    const move = (ev: PointerEvent) => {
      const p = {
        x: clamp(originX + ev.clientX - startX, 6, window.innerWidth - r.width - 6),
        y: clamp(originY + ev.clientY - startY, 6, window.innerHeight - r.height - 6),
      };
      posRef.current = p;
      setPos(p);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (posRef.current) savePosition(id, posRef.current);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  return (
    <section
      ref={ref}
      className={`fpanel tone-${tone}${isMobile ? ' sheet' : ''}${collapsed ? ' collapsed' : ''}`}
      style={!isMobile && pos ? { left: pos.x, top: pos.y, width } : { width: isMobile ? undefined : width }}
      aria-label={title}
    >
      <header className="fpanel-head" onPointerDown={onDown} title={isMobile ? undefined : '拖动可移动此面板'}>
        <span className="fpanel-grip" aria-hidden="true" />
        <h2 className="fpanel-title">{title}</h2>
        <div className="fpanel-btns">
          {collapsible && (
            <button className="fpanel-btn" onClick={() => setCollapsed((c) => !c)} aria-label={collapsed ? '展开' : '折叠'}>
              {collapsed ? '▸' : '▾'}
            </button>
          )}
          {onClose && (
            <button className="fpanel-btn" onClick={onClose} aria-label="关闭面板">
              ✕
            </button>
          )}
        </div>
      </header>
      {!collapsed && <div className="fpanel-body">{children}</div>}
    </section>
  );
}
