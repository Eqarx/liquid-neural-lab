/** 说明 / 图例 / 首次引导 三张卡片（v3：示意化管道）。 */
import { connectionCount } from '../core/model';
import { lab } from '../state/lab';
import { useLabSnapshot } from '../state/useLab';

export function HintCard({ onOpenSamples }: { onOpenSamples(): void }) {
  return (
    <div className="hint">
      <ol className="hint-steps">
        <li>
          在左边那块 <b>14×14 像素格</b> 上写一个数字 —— 写字时像素格实时亮起，<b>管道与球内液体也跟着实时变化</b>
          （那就是网络的输入）。
        </li>
        <li>
          想完整看一遍能量注入：点 <b>⚡ 注入能量</b>，或选一个<b>内置样本</b> ——
          这时才会播放「隐藏层 1 → 2 → 3 → 输出层」的逐层点亮动画并移动镜头。
        </li>
        <li>
          <b>点</b>任意大球看它的真实计算，<b>拖</b>它看液体晃动，鼠标<b>扫过管道</b>会把管子拨弯。
        </li>
      </ol>
      <div className="hint-actions">
        <button className="btn-ghost" onClick={onOpenSamples}>
          用内置样本试试
        </button>
        <button className="btn-ghost" onClick={() => lab().inject()}>
          ⚡ 注入能量
        </button>
      </div>
    </div>
  );
}

export function LegendCard() {
  // 架构与连接数一律从真实模型推导（避免文案与权重脱节）
  const snap = useLabSnapshot();
  const arch = snap.architecture.length ? snap.architecture : [196, 96, 64, 48, 10];
  const archText = arch.join(' → ');
  const edges = connectionCount(arch);
  return (
    <div className="legend">
      <div className="legend-row">
        <span className="lg-swatch liquid" /> 球内液体高度 = 该神经元的<b>真实激活值</b>
        （每层按最大值归一化后做非线性压缩，否则每个球都会灌满，看不出差别）
      </div>
      <div className="legend-row">
        <span className="lg-swatch pipe" /> 管道 = 层与层之间的连接；亮度 = 这一路的<b>正向推动</b>（w·a &gt; 0 的部分）
      </div>
      <div className="legend-row">
        <span className="lg-swatch pos" /> 通往输出层的管道：整体亮度 ∝ 该数字的<b>概率</b>，单根粗细 ∝ 它对该数字的贡献占比
        —— 所以<b>最亮的来路就是答案</b>
      </div>
      <div className="legend-row">
        <span className="lg-swatch dead" /> 深灰"空管" = 抑制性连接（w·a ≤ 0，在把该数字往下压）或贡献极低的连接，
        它们<b>仍在参与真实计算</b>
      </div>
      <div className="legend-row">
        <span className="lg-swatch none" /> 空画板时整条链路都是暗的：能量来自你画的像素，画得越多越强
      </div>
      <div className="legend-row">
        <span className="lg-swatch particle" /> 管内流动的光团 = 计算顺序的<b>动画示意</b>（网络内部没有真的粒子）
      </div>
      <div className="legend-row">
        <span className="lg-swatch out" /> 输出球上的数字与百分比 = 真实的 Softmax 概率
      </div>
      <p className="legend-note">
        画面是<b>示意</b>的：为看得清，每层只画最活跃的 8 / 6 / 4 个神经元与最强的若干条管道。
        真实计算始终使用全部 {archText} 与 {edges.toLocaleString()} 条连接，所有显示的数值都来自真实前向传播。
      </p>
    </div>
  );
}

export function IntroCard({ onClose }: { onClose(): void }) {
  const snap = useLabSnapshot();
  const arch = snap.architecture.length ? snap.architecture : [196, 96, 64, 48, 10];
  const acc = snap.metrics ? `，测试集 ${(snap.metrics.cleanTestAccuracy * 100).toFixed(1)}%` : '';
  return (
    <div className="intro-backdrop" role="dialog" aria-modal="true" aria-labelledby="intro-title">
      <div className="intro-card">
        <div className="intro-glyph" aria-hidden="true">
          <span className="intro-drop" />
        </div>
        <h2 id="intro-title">液光神经网络</h2>
        <p className="intro-lead">
          这是一个<b>真实训练过的神经网络</b>（{arch.join('→')}{acc}），全部推理在你的浏览器里完成。
          你画的像素就是它的输入，球里的"液体"就是它的真实激活值。
        </p>
        <ul className="intro-list">
          <li>
            <b>写</b>：直接在左侧 14×14 像素格上写数字，管道与液面实时跟着变
          </li>
          <li>
            <b>看</b>：点「⚡ 注入能量」或选一个内置样本，看能量逐层注入直到输出层
          </li>
          <li>
            <b>玩</b>：拖球体、拖整层、扫过管道，看液体晃动与管道回弹
          </li>
        </ul>
        <button className="btn-primary" onClick={onClose}>
          开始
        </button>
        <p className="intro-note">
          为了看得清楚，画面只画出每层最有代表性的若干神经元与管道（示意）；数值全部来自真实计算。
        </p>
      </div>
    </div>
  );
}
