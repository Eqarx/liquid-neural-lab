/** 顶部：品牌 + 三级界面切换 + 面板开关 + 状态。 */
import type { LabSnapshot } from '../state/lab';

export type Level = 'experience' | 'explore' | 'expert';

const LEVELS: { id: Level; name: string; desc: string }[] = [
  { id: 'experience', name: '体验', desc: '写一个数字，看能量逐层点亮' },
  { id: 'explore', name: '探索', desc: '调整连线/粒子/液体，点击神经元看计算' },
  { id: 'expert', name: '专家', desc: '真实架构、测试准确率、公式与性能' },
];

export interface PanelFlags {
  hint: boolean;
  result: boolean;
  legend: boolean;
  settings: boolean;
  model: boolean;
}

export function TopBar({
  level,
  onLevel,
  panels,
  onToggle,
  snap,
}: {
  level: Level;
  onLevel(l: Level): void;
  panels: PanelFlags;
  onToggle(k: keyof PanelFlags): void;
  snap: LabSnapshot;
}) {
  return (
    <header className="topbar">
      <div className="brand">
        <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="7" cy="12" r="4.2" fill="none" stroke="rgba(128,208,255,.85)" strokeWidth="1.4" />
          <path d="M7 9.4a4.2 4.2 0 0 0 0 5.2z" fill="rgba(128,208,255,.9)" />
          <circle cx="17.5" cy="12" r="2.4" fill="rgba(255,190,110,.9)" />
          <path d="M11 12h4" stroke="rgba(255,190,110,.5)" strokeWidth="1.2" />
        </svg>
        <div className="brand-text">
          <h1>液光神经网络</h1>
          <span className="brand-sub">手写数字 · 真实推理 · 可拖拽物理实验台</span>
        </div>
      </div>

      <nav className="level-pills" aria-label="界面层级">
        {LEVELS.map((l) => (
          <button
            key={l.id}
            className={`level-pill${level === l.id ? ' active' : ''}`}
            onClick={() => onLevel(l.id)}
            title={l.desc}
            aria-pressed={level === l.id}
          >
            {l.name}
          </button>
        ))}
      </nav>

      <div className="panel-toggles">
        <button className={`panel-tgl${panels.hint ? ' on' : ''}`} onClick={() => onToggle('hint')}>
          说明
        </button>
        <button className={`panel-tgl${panels.result ? ' on' : ''}`} onClick={() => onToggle('result')}>
          结果
        </button>
        <button className={`panel-tgl${panels.legend ? ' on' : ''}`} onClick={() => onToggle('legend')}>
          图例
        </button>
        {level !== 'experience' && (
          <button className={`panel-tgl${panels.settings ? ' on' : ''}`} onClick={() => onToggle('settings')}>
            参数
          </button>
        )}
        {level === 'expert' && (
          <button className={`panel-tgl${panels.model ? ' on' : ''}`} onClick={() => onToggle('model')}>
            模型
          </button>
        )}
        <span className={`status-dot${snap.modelReady ? ' ok' : ''}`} title={snap.modelReady ? '真实模型已就绪' : '正在加载模型'} />
      </div>
    </header>
  );
}
