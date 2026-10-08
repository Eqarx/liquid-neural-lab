/**
 * 通用多层感知机（N 层，逐神经元加权求和）—— 真实推理，无第三方运行时。
 * 与 scripts/train_digit_mlp.py 的 forward() 完全一致。
 */

export interface ModelLayer {
  w: Float32Array; // 行优先：第 j 行是该神经元对上一层全部输入的权重
  b: Float32Array;
  inN: number;
  outN: number;
}

export interface ModelParams {
  layers: ModelLayer[];
  side: number;
  arch: number[];
  id: string;
}

export interface ForwardResult {
  /** 每层加权和（激活前） */
  z: Float32Array[];
  /** 每层输出（激活后；最后一层为 Softmax 概率） */
  a: Float32Array[];
  probs: Float32Array;
}

export interface Summary {
  prediction: number;
  confidence: number;
  /** 第一名与第二名概率差 */
  margin: number;
  top3: { digit: number; prob: number }[];
}

/** 隐藏层规模（例如 [96, 64, 48]）—— 界面文案一律由此推导，避免与权重脱节 */
export function hiddenSizes(arch: number[]): number[] {
  return arch.slice(1, Math.max(1, arch.length - 1));
}

/** 真实连接数（层间全连接边数之和） */
export function connectionCount(arch: number[]): number {
  let n = 0;
  for (let i = 0; i + 1 < arch.length; i++) n += arch[i] * arch[i + 1];
  return n;
}

export function softmax(logits: ArrayLike<number>, out?: Float32Array): Float32Array {
  const n = logits.length;
  const res = out ?? new Float32Array(n);
  let m = -Infinity;
  for (let i = 0; i < n; i++) if (logits[i] > m) m = logits[i];
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const e = Math.exp(logits[i] - m);
    res[i] = e;
    sum += e;
  }
  for (let i = 0; i < n; i++) res[i] /= sum || 1;
  return res;
}

export function forwardModel(model: ModelParams, x: ArrayLike<number>): ForwardResult {
  const z: Float32Array[] = [];
  const a: Float32Array[] = [];
  let cur: Float32Array = x instanceof Float32Array ? x : Float32Array.from(x);
  for (let li = 0; li < model.layers.length; li++) {
    const layer = model.layers[li];
    const zl = new Float32Array(layer.outN);
    const al = new Float32Array(layer.outN);
    const last = li === model.layers.length - 1;
    for (let j = 0; j < layer.outN; j++) {
      let s = layer.b[j];
      const off = j * layer.inN;
      for (let i = 0; i < layer.inN; i++) s += layer.w[off + i] * cur[i];
      zl[j] = s;
    }
    if (last) softmax(zl, al);
    else for (let j = 0; j < layer.outN; j++) al[j] = zl[j] > 0 ? zl[j] : 0;
    z.push(zl);
    a.push(al);
    cur = al;
  }
  return { z, a, probs: a[a.length - 1] };
}

export function summarize(f: ForwardResult): Summary {
  const probs = f.probs;
  const order = Array.from({ length: probs.length }, (_, i) => i).sort((p, q) => probs[q] - probs[p]);
  return {
    prediction: order[0],
    confidence: probs[order[0]],
    margin: probs[order[0]] - probs[order[1]],
    top3: order.slice(0, 3).map((d) => ({ digit: d, prob: probs[d] })),
  };
}

/** 单个神经元的输入贡献：contrib[i] = w[i] * x[i] */
export function contributions(layer: ModelLayer, idx: number, prevActs: ArrayLike<number>) {
  const w = layer.w.subarray(idx * layer.inN, (idx + 1) * layer.inN);
  const c = new Float32Array(layer.inN);
  let sum = layer.b[idx];
  for (let i = 0; i < layer.inN; i++) {
    c[i] = w[i] * prevActs[i];
    sum += c[i];
  }
  return { w, c, sum, bias: layer.b[idx] };
}

export function maxOf(v: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < v.length; i++) if (v[i] > m) m = v[i];
  return m || 1;
}
