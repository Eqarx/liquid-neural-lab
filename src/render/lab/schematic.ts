/**
 * 示意计划（Schematic Plan）—— 决定"画面上显示哪些神经元与哪些管道"。
 *
 * 重要区分：
 *   · 数值全部真实：节点液面 = 该神经元的真实激活值；管道能量 = 真实贡献 |w·x| 归一化。
 *   · 拓扑是示意的：每层只显示最有代表性的若干神经元与最强若干净管道，
 *     真实计算仍然使用全部 196→96→64→48→10 与 28,512 条连接（专家面板可查）。
 *
 * 这样做的原因：把 28,512 条线和 154 个节点画出来既慢又看不清；
 * 教学上"看得懂的示意 + 真实数值"比"看不清的全量"更有效。
 */

import type { ModelParams } from '../../core/model';
import type { LabLayout } from './geometry';
import { SLOT_COUNT } from './geometry';

export interface PipeSpec {
  id: number;
  fromLayer: number; // 0 = 输入汇流排, 1..3 = 上一层大节点
  fromSlot: number; // -1 表示汇流排
  toLayer: number; // 1..4
  toSlot: number;
  /** 真实神经元下标（用于检查器与数值展示） */
  fromNeuron: number;
  toNeuron: number;
  /** 管道强度 0..1（真实贡献归一化后，再按显示阈值压缩：0 = 空管） */
  energy: number;
  /** 归一化后的原始贡献（未做显示阈值处理，供检查器展示） */
  raw: number;
  /** 管径（世界单位） */
  width: number;
}

export interface SchematicPlan {
  /** 每层槽位 → 真实神经元下标（层 0 = 输入，占位 196 个） */
  slots: number[][];
  pipes: PipeSpec[];
  /** 输入总能量（驱动环境粒子密度） */
  inputEnergy: number;
}

/**
 * 输入层的"正向推动总量"：Σ max(0, w·x)。
 * 只统计**兴奋性**贡献 —— 负权重是在抑制这个神经元，
 * 若用绝对值，抑制性连接会和兴奋性一样亮，画面就会"指向错误的数字"。
 */
function layerContribution(w: Float32Array, inN: number, src: ArrayLike<number>, outIdx: number): number {
  let s = 0;
  const off = outIdx * inN;
  for (let i = 0; i < inN; i++) {
    const c = w[off + i] * src[i];
    if (c > 0) s += c;
  }
  return s;
}

/** 从一组激活值里取最强的 k 个真实神经元下标 */
function topK(values: ArrayLike<number>, k: number): number[] {
  const idx = Array.from({ length: values.length }, (_, i) => i);
  idx.sort((a, b) => values[b] - values[a]);
  const picked = idx.slice(0, k);
  // 稳定排序：槽位顺序按神经元下标，避免画面里节点来回跳
  picked.sort((a, b) => a - b);
  return picked;
}

/** 权重质量（用于空输入时挑"代表神经元"） */
function weightMass(w: Float32Array, inN: number, outIdx: number): number {
  let s = 0;
  const off = outIdx * inN;
  for (let i = 0; i < inN; i++) s += Math.abs(w[off + i]);
  return s;
}

/**
 * 生成示意计划。
 * @param picksNewSlots true = 重新挑选显示的神经元（换数字/停笔时）；false = 沿用旧槽位（写字过程中保持稳定）
 */
export function computeSchematic(
  model: ModelParams,
  acts: Float32Array[] | null,
  inputValues: Float32Array,
  layout: LabLayout,
  prev: SchematicPlan | null,
  picksNewSlots: boolean,
): SchematicPlan {
  const [w1, w2, w3, w4] = model.layers;
  const a1 = acts?.[0] ?? new Float32Array(w1.outN);
  const a2 = acts?.[1] ?? new Float32Array(w2.outN);
  const a3 = acts?.[2] ?? new Float32Array(w3.outN);
  const probs = acts?.[3] ?? new Float32Array(10);
  const inputSrc = inputValues;

  // ---- 槽位选择 ----
  let slots: number[][];
  if (!picksNewSlots && prev) {
    slots = prev.slots;
  } else {
    const pick = (layer: 0 | 1 | 2, k: number) => {
      const w = [w1, w2, w3][layer];
      const a = [a1, a2, a3][layer];
      let anyActive = false;
      for (let i = 0; i < a.length; i++) {
        if (a[i] > 0.01) {
          anyActive = true;
          break;
        }
      }
      if (anyActive) return topK(a, k);
      // 全零输入（空白画板）：挑权重质量最大的，画面不至于空着
      const mass = Array.from({ length: w.outN }, (_, i) => weightMass(w.w, w.inN, i));
      const idx = Array.from({ length: w.outN }, (_, i) => i).sort((p, q) => mass[q] - mass[p]).slice(0, k);
      idx.sort((p, q) => p - q);
      return idx;
    };
    slots = [
      Array.from({ length: 196 }, (_, i) => i), // 输入层槽位 = 像素格（全部保留）
      pick(0, SLOT_COUNT.l1),
      pick(1, SLOT_COUNT.l2),
      pick(2, SLOT_COUNT.l3),
      Array.from({ length: 10 }, (_, i) => i), // 输出层 = 10 个数字，固定
    ];
  }

  // ---- 管道 ----
  const pipes: PipeSpec[] = [];
  let id = 0;

  // L1：每个大节点一根总管（起点在输入层背面的汇流排）
  const l1Energy: number[] = [];
  for (let s = 0; s < slots[1].length; s++) {
    const j = slots[1][s];
    l1Energy.push(layerContribution(w1.w, w1.inN, inputSrc, j));
  }
  const maxL1 = Math.max(...l1Energy, 1e-6);
  for (let s = 0; s < slots[1].length; s++) {
    pipes.push({
      id: id++,
      fromLayer: 0,
      fromSlot: -1,
      toLayer: 1,
      toSlot: s,
      fromNeuron: -1,
      toNeuron: slots[1][s],
      energy: l1Energy[s] / maxL1,
      raw: 0,
      width: 0,
    });
  }

  /**
   * 层间管道。
   *
   * 显示规则（画面上"最亮的通路"必须指向答案）：
   *   单根管道能量 = 该数字的**整体推动量占比** × 这根管道在该数字内部的**贡献占比**
   *   · 整体推动量：对**全部**输入求和（不只显示的那几根），所以"最粗最亮的来路"就是答案；
   *   · 输出层用 softmax 概率作为整体量，其余层用该层内最大的总正向推动归一化；
   *   · 只统计正向推动 max(0, w·a)：负权重在抑制该神经元，画成空管。
   */
  const chain = (
    layerIdx: 1 | 2 | 3,
    prevSlots: number[],
    nextSlots: number[],
    prevActs: ArrayLike<number>,
    layer: { w: Float32Array; inN: number; outN: number },
    perNode: number,
    nodeWeight?: ArrayLike<number>,
  ) => {
    // 1) 每个目标节点的总推动量（对全部输入求和）
    const drive = nextSlots.map((j) => {
      let total = 0;
      const off = j * layer.inN;
      for (let i = 0; i < layer.inN; i++) {
        const c = layer.w[off + i] * prevActs[i];
        if (c > 0) total += c;
      }
      return total;
    });
    const maxDrive = Math.max(1e-6, ...drive);
    // 输出层：用概率（相对最大概率）作为整体量 → 越可能的数字，来路越亮
    const relOf = (t: number) => {
      if (nodeWeight) {
        let mx = 1e-6;
        for (const j of nextSlots) if (nodeWeight[j] > mx) mx = nodeWeight[j];
        return nodeWeight[nextSlots[t]] / mx;
      }
      return drive[t] / maxDrive;
    };

    // 2) 每个节点内部：分支贡献占比
    const strength: number[][] = [];
    for (let t = 0; t < nextSlots.length; t++) {
      const j = nextSlots[t];
      const rows: { s: number; c: number }[] = [];
      for (let s = 0; s < prevSlots.length; s++) {
        const src = prevSlots[s];
        rows.push({ s, c: Math.max(0, layer.w[j * layer.inN + src] * prevActs[src]) });
      }
      const nodeMax = Math.max(1e-6, ...rows.map((r) => r.c));
      rows.sort((a, b) => b.c - a.c);
      for (const r of rows.slice(0, perNode)) strength.push([t, r.s, (relOf(t) * r.c) / nodeMax]);
    }
    for (const [t, s, c] of strength) {
      pipes.push({
        id: id++,
        fromLayer: layerIdx,
        fromSlot: s,
        toLayer: layerIdx + 1,
        toSlot: t,
        fromNeuron: prevSlots[s],
        toNeuron: nextSlots[t],
        energy: c,
        raw: 0,
        width: 0,
      });
    }
  };

  chain(1, slots[1], slots[2], a1, w2, 2);
  chain(2, slots[2], slots[3], a2, w3, 2);
  // 输出层：整体亮度按真实概率（相对最大概率），保证"最亮的来路 = 答案"
  chain(3, slots[3], slots[4], a3, w4, 3, probs);

  // ---- 输入总能量：既是环境粒子的密度，也是整条链路能量的"总闸" ----
  // 说明：即使不画任何东西，偏置项也会让隐藏层有非零激活（这是真实的），
  // 但"能量来自你画的像素"这条教学线索要求：没有输入时整条链路就是暗的。
  let e = 0;
  for (let i = 0; i < inputSrc.length; i++) e += inputSrc[i];
  const inputEnergy = Math.min(1, e / 12);
  const gate = Math.min(1, Math.max(0, e - 0.35) / 6);

  // ---- 管径与亮度：只有"贡献显著"的管道才点亮（其余是空管，仍在真实计算中） ----
  const THRESHOLD = 0.34;
  for (const p of pipes) {
    const raw = p.energy * gate;
    const lit = raw <= THRESHOLD ? 0 : (raw - THRESHOLD) / (1 - THRESHOLD);
    p.raw = raw;
    p.energy = lit;
    const base = p.fromLayer === 0 ? 11 : 8;
    const span = p.fromLayer === 0 ? 19 : 15;
    // 管径也强烈区分：低能量细、高能量粗
    p.width = lit <= 0 ? base - 3 : base + span * Math.pow(lit, 0.9);
  }

  // ---- 输入总能量（驱动环境粒子） ----

  void layout;
  return { slots, pipes, inputEnergy };
}
