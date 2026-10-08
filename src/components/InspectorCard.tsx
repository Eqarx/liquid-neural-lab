/** 神经元检查器：显示画面上这个节点对应的**真实神经元**的计算明细。 */
import type { LabSnapshot } from '../state/lab';

const LAYER_NAME = ['', '隐藏层 1', '隐藏层 2', '隐藏层 3', '输出层'];
const fmt = (v: number, d = 4) => {
  const s = v.toFixed(d);
  return s.replace(/\.?0+$/, '') || '0';
};

export function InspectorCard({ snap, level }: { snap: LabSnapshot; level: 'experience' | 'explore' | 'expert' }) {
  const ins = snap.inspector;
  if (!ins) return null;
  const topN = level === 'experience' ? 6 : level === 'explore' ? 12 : ins.contributions.length;
  const rows = ins.contributions.slice(0, topN);
  const isOutput = ins.layer === 4;

  return (
    <div className="inspector">
      <div className="ins-head">
        <span className="ins-title">
          {LAYER_NAME[ins.layer]} · 真实编号 #{ins.neuron}
        </span>
        <span className="ins-value">{isOutput ? `概率 ${(ins.activation * 100).toFixed(2)}%` : `激活值 ${fmt(ins.activation, 5)}`}</span>
      </div>
      <p className="ins-note">
        画面每层只显示最活跃的若干个神经元，这是其中之一（该层共 {ins.neuronCount} 个，全部参与真实计算）。
      </p>

      {isOutput ? (
        <>
          <p className="ins-note">
            原始分数 z = <b className="mono">{fmt(ins.z, 4)}</b>，经过 Softmax 变成概率：分子 <span className="mono">e^z</span>，
            分母是 10 个神经元的 e^z 之和。
          </p>
          <p className="ins-formula">p = e^(z − zmax) / Σ e^(zk − zmax)</p>
        </>
      ) : (
        <>
          <ol className="ins-steps">
            <li>收到上一层全部 {ins.srcTotal} 个信号</li>
            <li>每个信号乘以自己的权重（琥珀=正，蓝=负）</li>
            <li>求和后加上偏置 b = <b className="mono">{fmt(ins.bias)}</b></li>
            <li>经过 ReLU：a = max(0, z)</li>
          </ol>
          <div className="ins-rows">
            <div className="ins-row head">
              <span>来源</span>
              <span>权重 w</span>
              <span>输入 x</span>
              <span>w·x</span>
            </div>
            {rows.map((r) => (
              <div className={`ins-row${r.c >= 0 ? ' pos' : ' neg'}`} key={r.src}>
                <span className="ins-src">
                  {ins.layer === 1 ? `像素(${Math.floor(r.src / 14) + 1},${(r.src % 14) + 1})` : `上一层 #${r.src + 1}`}
                </span>
                <span className="mono">{fmt(r.w)}</span>
                <span className="mono">{fmt(r.x)}</span>
                <span className="mono">
                  {r.c >= 0 ? '+' : ''}
                  {fmt(r.c)}
                </span>
              </div>
            ))}
          </div>
          <p className="ins-formula">a = max(0, Σ wᵢ·xᵢ + b)</p>
          {level !== 'expert' && (
            <p className="ins-note">
              以上只显示贡献最大的 {topN} 项；真实计算包含全部 {ins.srcTotal} 项（专家层级可看完整公式）。
            </p>
          )}
        </>
      )}
      <span className="ro-badge">只读 · 真实计算值</span>
    </div>
  );
}
