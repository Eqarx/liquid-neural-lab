/**
 * 画布舞台：全屏 canvas（交互层）+ 可拖动的层标签（DOM，保证文字清晰）+ 悬停提示。
 * 数值提示来自引擎（真实激活值），拓扑是示意的（只画代表神经元与主管道）。
 */
import { useEffect, useRef, useState } from 'react';
import { lab } from '../state/lab';
import { useLabSnapshot } from '../state/useLab';

export function LabCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelsRef = useRef(new Map<string, HTMLElement>());
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const snap = useLabSnapshot();
  const engine = lab();
  const blocks = engine.layout.blocks;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    engine.attach(canvas, labelsRef.current);
    void engine.init();
    if (import.meta.env.DEV) {
      (window as unknown as { __lab: unknown }).__lab = engine;
    }
    return () => engine.detach();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startLayerDrag = (key: string) => (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    engine.beginLayerDrag(key);
    const move = (ev: PointerEvent) => engine.moveLayerDrag(ev.clientX - startX, ev.clientY - startY);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      engine.endLayerDrag();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  return (
    <div className="lab-stage" onPointerMove={(e) => setCursor({ x: e.clientX, y: e.clientY })} onPointerLeave={() => setCursor(null)}>
      <canvas ref={canvasRef} className="lab-canvas" role="img" aria-label={ariaFor(snap.prediction, snap.confidence)} />
      {blocks.map((b) => (
        <div
          key={b.key}
          className="layer-chip"
          ref={(el) => {
            if (el) labelsRef.current.set(b.key, el);
          }}
          onPointerDown={startLayerDrag(b.key)}
          title="拖动可整层移动（松手回弹）"
        >
          <span className="layer-chip-label">{b.label}</span>
          <span className="layer-chip-sub">{b.sub}</span>
        </div>
      ))}
      {snap.hoverText && cursor && (
        <div className="hover-tip" style={{ transform: `translate(${cursor.x + 16}px, ${cursor.y + 16}px)` }}>
          <span className="hover-tip-title">{snap.hoverText.title}</span>
          <span className="hover-tip-value">{snap.hoverText.value}</span>
          {snap.hoverText.sub && <span className="hover-tip-sub">{snap.hoverText.sub}</span>}
        </div>
      )}
    </div>
  );
}

function ariaFor(prediction: number | null, confidence: number): string {
  const base = '神经网络交互画布：左侧 14×14 像素格可直接手写，能量经管道注入每一层，直到输出层。';
  if (prediction === null) return `${base} 当前还没有输入。`;
  return `${base} 当前预测数字 ${prediction}，置信度 ${Math.round(confidence * 100)}%。`;
}
