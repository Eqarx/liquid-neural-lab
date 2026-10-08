/** 专家面板：真实架构、参数、测试准确率、公式与性能读数（全部只读）。 */
import { useEffect } from 'react';
import { connectionCount, hiddenSizes } from '../core/model';
import { lab, type LabSnapshot } from '../state/lab';

export function ModelCard({ snap }: { snap: LabSnapshot }) {
  // 打开时每 0.5s 刷新一次快照，让 fps / 粒子数等实时读数保持鲜活
  useEffect(() => {
    lab().perfTick(true);
    return () => lab().perfTick(false);
  }, []);
  const m = snap.metrics;
  const arch = snap.architecture;
  const params = snap.totalParams;
  // 文案里的架构 / 连接数一律由真实模型推导，避免与权重脱节
  const hidden = hiddenSizes(arch.length ? arch : [196, 96, 64, 48, 10]);
  const edgeCount = connectionCount(arch.length ? arch : [196, 96, 64, 48, 10]);
  // 架构表：输入层 + 各隐藏层 + 输出层
  const layers: { name: string; n: number; act: string }[] = [];
  if (arch.length) {
    for (let i = 0; i < arch.length; i++) {
      const isInput = i === 0;
      const isOutput = i === arch.length - 1;
      layers.push({
        name: isInput ? '输入层' : isOutput ? '输出层' : `隐藏层 ${i}`,
        n: arch[i],
        act: isInput ? '（直接传入像素值）' : isOutput ? 'Softmax' : 'ReLU',
      });
    }
  }

  return (
    <div className="model-card">
      {m ? (
        <div className="acc-row">
          <div>
            <div className="acc-num mono">{(m.cleanTestAccuracy * 100).toFixed(2)}%</div>
            <div className="acc-label">MNIST 测试集准确率</div>
          </div>
          <div>
            <div className="acc-num mono small">{(m.jitterTestAccuracy * 100).toFixed(2)}%</div>
            <div className="acc-label">加入平移/缩放/浓淡抖动后</div>
          </div>
        </div>
      ) : (
        <p className="note">正在加载评测数据…</p>
      )}

      <table className="arch-table">
        <thead>
          <tr>
            <th>层</th>
            <th>神经元</th>
            <th>激活函数</th>
          </tr>
        </thead>
        <tbody>
          {layers.map((l, i) => (
            <tr key={`${l.name}-${i}`}>
              <td>{l.name}</td>
              <td className="mono">{l.n}</td>
              <td className="mono">{l.act}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="note">
        共 <b className="mono">{params.toLocaleString()}</b> 个参数（float32 权重 + 偏置）。输入是 14×14 像素格，
        你画下的 196 个值就是网络的 196 个输入 —— 不做裁剪、不做居中，所见即所算。
      </p>
      <p className="formula">h₁ = ReLU(W₁x + b₁) · h₂ = ReLU(W₂h₁ + b₂) · h₃ = ReLU(W₃h₂ + b₃) · p = softmax(W₄h₃ + b₄)</p>
      <p className="note schematic-note">
        <b>示意 vs 真实</b>：画面上每层只显示最活跃的 8 / 6 / 4 个神经元（共 28 个大球）与最强的
        <b className="mono"> {snap.pipes || 58} </b> 根管道；而真实前向传播使用全部
        <b className="mono"> {hidden.join(' / ')} </b> 个神经元与 <b className="mono">{edgeCount.toLocaleString()}</b> 条连接。
        所有显示的数值（激活值、概率、管径与亮度）都来自真实计算，只有"画多少"是示意的。
      </p>
      {m && (
        <p className="note">
          数据集：{m.dataset}（CC BY-SA 3.0，LeCun/Cortes/Burges）。权重由本项目脚本从零训练（{m.trainedAt}），
          不含任何第三方模型。准确率为真实测量值，未做任何修饰。
        </p>
      )}

      <div className="perf-grid">
        <span>
          帧率 <b className="mono">{snap.fps.toFixed(0)} fps</b>
        </span>
        <span>
          帧耗时 <b className="mono">{snap.frameMs.toFixed(2)} ms</b>
        </span>
        <span>
          管道 <b className="mono">{snap.pipes}</b>
        </span>
        <span>
          光团 <b className="mono">{snap.particles}</b>
        </span>
        <span>
          拨弯的管 <b className="mono">{snap.plucking}</b>
        </span>
        <span>
          级联阶段 <b className="mono">{snap.cascadeStage < 0 ? '待命' : snap.cascadeStage + 1}</b>
        </span>
      </div>

      {m && (
        <>
          <div className="sub-title">每类准确率</div>
          <div className="per-class">
            {m.perClassAccuracy.map((v, i) => (
              <div className="pc-row" key={i}>
                <span className="mono pc-digit">{i}</span>
                <div className="pc-track">
                  <div className="pc-fill" style={{ transform: `scaleX(${v.toFixed(4)})` }} />
                </div>
                <span className="mono pc-val">{(v * 100).toFixed(1)}</span>
              </div>
            ))}
          </div>
        </>
      )}
      <span className="ro-badge">只读 · 不提供训练与反向传播</span>
    </div>
  );
}
