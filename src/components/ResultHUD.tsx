/**
 * 识别结果浮窗：大数字 + 十条概率 + 候选 + 不确定性 + 注入能量入口。
 * 概率条只动 transform（compositor-only），弹簧平滑、可中断。
 */
import { useEffect, useRef } from 'react';
import { frameLoop } from '../motion/frameLoop';
import { Spring, SPRING } from '../motion/spring';
import { useReducedMotion } from '../motion/useReducedMotion';
import { lab } from '../state/lab';
import type { LabSnapshot } from '../state/lab';

export function ResultHUD({ snap }: { snap: LabSnapshot }) {
  const reduced = useReducedMotion();
  const bars = useRef<(HTMLDivElement | null)[]>([]);
  const springs = useRef<Spring[]>(Array.from({ length: 10 }, () => new Spring(0, SPRING.data)));
  const top = snap.prediction;

  useEffect(() => {
    const targets = snap.probs;
    if (reduced) {
      for (let i = 0; i < 10; i++) springs.current[i].snap(targets[i] ?? 0);
      apply();
      return;
    }
    for (let i = 0; i < 10; i++) springs.current[i].setTarget(targets[i] ?? 0);
    const tick = (dt: number) => {
      let any = false;
      for (const s of springs.current) any = s.step(dt) || any;
      apply();
      if (!any) frameLoop.stop(tick);
    };
    frameLoop.start(tick);
    return () => frameLoop.stop(tick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap.probs, reduced]);

  function apply() {
    for (let i = 0; i < 10; i++) {
      const el = bars.current[i];
      if (el) el.style.transform = `scaleX(${springs.current[i].value.toFixed(4)})`;
    }
  }

  const uncertain = snap.margin > 0 ? snap.margin < 0.09 : false;
  const modelReady = snap.modelReady;

  return (
    <div className="result-hud">
      <div className="result-top">
        <div className="result-digit" key={top ?? -1}>
          {top === null ? '–' : top}
        </div>
        <div className="result-meta">
          {top !== null ? (
            <>
              <div className="result-line">
                我猜这是 <b>{top}</b>
                <span className="result-pct">{(snap.confidence * 100).toFixed(1)}%</span>
              </div>
              {uncertain ? (
                <div className="badge warn">不太确定：第 2 候选只差 {(snap.margin * 100).toFixed(1)}%</div>
              ) : (
                <div className="badge ok">比第 2 候选高 {(snap.margin * 100).toFixed(1)}%</div>
              )}
            </>
          ) : (
            <div className="result-line">{modelReady ? '在左侧像素格上写一个数字' : '正在加载模型…'}</div>
          )}
        </div>
      </div>

      <div className="prob-bars">
        {Array.from({ length: 10 }, (_, i) => (
          <div className="prob-row" key={i}>
            <span className={`prob-label${i === top ? ' top' : ''}`}>{i}</span>
            <div className="prob-track">
              <div
                className={`prob-fill${i === top ? ' top' : ''}`}
                ref={(el) => {
                  bars.current[i] = el;
                }}
                title={`数字 ${i}：${((snap.probs[i] ?? 0) * 100).toFixed(2)}%`}
              />
            </div>
            <span className={`prob-val${i === top ? ' top' : ''}`}>{((snap.probs[i] ?? 0) * 100).toFixed((snap.probs[i] ?? 0) < 0.1 ? 1 : 0)}%</span>
          </div>
        ))}
      </div>

      {snap.top3.length > 1 && (
        <div className="candidates">
          {snap.top3.slice(1).map((t, i) => (
            <span className="cand" key={t.digit}>
              第 {i + 2} 候选 <b>{t.digit}</b> {(t.prob * 100).toFixed(1)}%
            </span>
          ))}
        </div>
      )}

      {snap.sampleMeta && top !== null && (
        <div className={`sample-verdict ${snap.sampleMeta.correct ? 'ok' : 'warn'}`}>
          真实标签 {snap.sampleMeta.label} · 预测 {top}
          {snap.sampleMeta.correct ? ' —— 识别正确 ✓' : ' —— 识别错误 ✗（模型真实会犯的错）'}
        </div>
      )}

      <button className="inject-btn" onClick={() => lab().inject()} disabled={!modelReady}>
        ⚡ 注入能量（看它逐层点亮）
      </button>
    </div>
  );
}
