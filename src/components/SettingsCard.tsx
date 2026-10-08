/** 探索面板：能量流亮度、粒子密度、液体、跟随镜头、级联速度 + 示意化说明。 */
import { connectionCount, hiddenSizes } from '../core/model';
import { lab, type LabSnapshot } from '../state/lab';

export function SettingsCard({ snap }: { snap: LabSnapshot }) {
  const s = snap.settings;
  const set = lab().setSetting.bind(lab());
  const arch = snap.architecture.length ? snap.architecture : [196, 96, 64, 48, 10];
  const edges = connectionCount(arch);

  return (
    <div className="settings">
      <label className="ctl">
        <span className="ctl-label">
          能量流亮度 <b className="mono">{s.flowBrightness.toFixed(2)}×</b>
        </span>
        <input type="range" min={0.2} max={2} step={0.05} value={s.flowBrightness} onChange={(e) => set('flowBrightness', Number(e.target.value))} />
        <span className="ctl-note">管道里流动的亮度 = 该连接的真实贡献（权重 × 输入）归一化后的值。</span>
      </label>
      <label className="ctl">
        <span className="ctl-label">
          粒子密度 <b className="mono">{s.particleDensity.toFixed(2)}</b>
        </span>
        <input type="range" min={0} max={2} step={0.05} value={s.particleDensity} onChange={(e) => set('particleDensity', Number(e.target.value))} />
        <span className="ctl-note">光团沿管道流动，到达节点时把能量注入进去（液面上升）。</span>
      </label>
      <label className="ctl">
        <span className="ctl-label">
          级联速度 <b className="mono">{s.cascadeSpeed.toFixed(2)}×</b>
        </span>
        <input type="range" min={0.4} max={2.5} step={0.05} value={s.cascadeSpeed} onChange={(e) => set('cascadeSpeed', Number(e.target.value))} />
      </label>
      <div className="ctl-toggles">
        <button className={`tgl${s.liquid ? ' on' : ''}`} onClick={() => set('liquid', !s.liquid)} aria-pressed={s.liquid}>
          🧪 液体显示激活值
        </button>
        <button className={`tgl${s.followCamera ? ' on' : ''}`} onClick={() => set('followCamera', !s.followCamera)} aria-pressed={s.followCamera}>
          🎥 级联时跟随镜头
        </button>
        <button className={`tgl${s.showLabels ? ' on' : ''}`} onClick={() => set('showLabels', !s.showLabels)} aria-pressed={s.showLabels}>
          🔢 节点上显示真实数值
        </button>
      </div>
      <button className="btn-ghost wide" onClick={() => lab().resetSettings()}>
        恢复默认
      </button>
      <p className="ctl-note schematic-note">
        画面是<b>示意</b>的：每层只画最活跃的 8 / 6 / 4 个神经元，管道只连最强的若干条；
        真实计算仍然使用全部 {hiddenSizes(arch).join(' / ')} 个神经元与 {edges.toLocaleString()} 条连接（数值都是真的）。
      </p>
    </div>
  );
}
