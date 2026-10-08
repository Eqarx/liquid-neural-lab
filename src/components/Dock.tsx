/** 底部工具栏：画笔/橡皮、注入能量、清空、镜头、样本。 */
import { useEffect, useRef, useState } from 'react';
import { lab, type LabSnapshot } from '../state/lab';

export function Dock({
  snap,
  samplesOpen,
  onSamplesOpen,
}: {
  snap: LabSnapshot;
  /** 样本面板由 App 托管，这样引导卡/说明卡也能直接打开它 */
  samplesOpen: boolean;
  onSamplesOpen: (v: boolean) => void;
}) {
  const [erase, setErase] = useState(false);

  useEffect(() => {
    lab().setErase(erase);
  }, [erase]);

  return (
    <div className="dock-wrap">
      {samplesOpen && (
        <div className="samples-pop" role="dialog" aria-label="内置样本">
          <div className="samples-pop-head">
            <span>内置样本（来自 MNIST 测试集，含模型识别错误的例子）</span>
            <button className="fpanel-btn" onClick={() => onSamplesOpen(false)} aria-label="关闭样本面板">
              ✕
            </button>
          </div>
          <div className="samples-pop-grid">
            {lab().samples.map((s) => (
              <button
                key={s.id}
                className="sample-chip"
                onClick={() => {
                  lab().loadSample(s);
                  onSamplesOpen(false);
                }}
                title={`真实标签 ${s.label} · 模型预测 ${s.prediction}${s.correct ? '' : '（识别错误样本）'}`}
              >
                <SampleThumb raw={s.raw14} />
                <span className="sample-meta">
                  {s.label}
                  {s.correct ? '' : ' ✱'}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="dock" role="toolbar" aria-label="实验台工具">
        <button className={`dock-btn${!erase ? ' active' : ''}`} onClick={() => setErase(false)} aria-pressed={!erase}>
          ✏️ 画笔
        </button>
        <button className={`dock-btn${erase ? ' active' : ''}`} onClick={() => setErase(true)} aria-pressed={erase}>
          🧽 橡皮
        </button>
        <span className="dock-sep" />
        <button className="dock-btn warm" onClick={() => lab().inject()} disabled={!snap.modelReady}>
          ⚡ 注入能量
        </button>
        <button className="dock-btn" onClick={() => lab().clear()}>
          🧹 清空
        </button>
        <span className="dock-sep" />
        <button className="dock-btn" onClick={() => lab().focusInput()} title="把镜头移到输入像素格">
          🎯 输入格
        </button>
        <button className="dock-btn" onClick={() => lab().fitAll()} title="看到整张网络">
          🔍 全览
        </button>
        <button
          className="dock-btn"
          onClick={() => lab().resetAll()}
          title="复位（等同刷新页面）：浮窗、镜头、设置值、球与管道全部回到初始状态（保留你的手写）"
        >
          ⟲ 复位
        </button>
        <span className="dock-sep" />
        <button className="dock-btn" onClick={() => onSamplesOpen(!samplesOpen)} aria-expanded={samplesOpen}>
          ▦ 样本
        </button>
      </div>
    </div>
  );
}

function SampleThumb({ raw }: { raw: number[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, 14, 14);
    for (let i = 0; i < 196; i++) {
      const v = raw[i] / 255;
      if (v <= 0.03) continue;
      ctx.fillStyle = `rgba(233, 237, 249, ${(0.25 + 0.75 * v).toFixed(3)})`;
      ctx.fillRect(i % 14, Math.floor(i / 14), 1, 1);
    }
  }, [raw]);
  return <canvas ref={ref} width={14} height={14} className="sample-thumb" aria-hidden="true" />;
}
