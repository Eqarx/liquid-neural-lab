/**
 * 实验台引擎 —— 单例。拥有：模型、输入像素格、真实推理、示意计划、场景、设置、快照。
 *
 * 真实 vs 示意（重要）：
 *   · 推理完全真实：196 → 96 → 64 → 48 → 10，全部权重参与，数值来自真实计算；
 *   · 画面是示意的：每层只显示最有代表性的若干"大节点"，管道只连接最强的若干条；
 *     具体显示哪些神经元由真实激活值决定（会随输入变化），被省略的数量在界面里写明。
 */

import { contributions, forwardModel, summarize, type ModelParams, type Summary } from '../core/model';
import { InputGrid } from '../core/inputGrid';
import { loadMetrics, loadModel, loadSamples, type Metrics, type Sample } from '../core/assets';
import { computeLayout, type LabLayout } from '../render/lab/geometry';
import { LabScene, type HitTarget, type LabSceneHost, type LabSettings } from '../render/lab/scene';
import { NodeSystem } from '../render/lab/nodes';
import { PipeSystem } from '../render/lab/pipes';
import { computeSchematic, type SchematicPlan } from '../render/lab/schematic';
import { emitUiReset } from './uiReset';

export interface InspectorData {
  layer: number; // 1..4（权重层）
  slot: number; // 画面槽位
  neuron: number; // 真实神经元下标
  neuronCount: number; // 该层真实神经元总数
  activation: number;
  z: number;
  bias: number;
  sum: number;
  contributions: { src: number; w: number; x: number; c: number }[];
  srcTotal: number;
}

export interface LabSnapshot {
  version: number;
  modelReady: boolean;
  error: string | null;
  prediction: number | null;
  confidence: number;
  margin: number;
  probs: number[];
  top3: { digit: number; prob: number }[];
  ink: number;
  hover: HitTarget | null;
  hoverText: { title: string; value: string; sub?: string } | null;
  inspector: InspectorData | null;
  fps: number;
  frameMs: number;
  pipes: number;
  particles: number;
  plucking: number;
  cascadeStage: number;
  sampleMeta: { label: number; correct: boolean } | null;
  architecture: number[];
  totalParams: number;
  settings: LabSettings;
  metrics: {
    cleanTestAccuracy: number;
    jitterTestAccuracy: number;
    perClassAccuracy: number[];
    dataset: string;
    trainedAt: string;
  } | null;
}

const DEFAULT_SETTINGS: LabSettings = {
  flowBrightness: 1,
  particleDensity: 0.9,
  liquid: true,
  followCamera: true,
  showLabels: true,
  cascadeSpeed: 1,
};

const SETTINGS_KEY = 'digitlab-v3-settings';

class LabEngine implements LabSceneHost {
  readonly layout: LabLayout = computeLayout();
  readonly nodes = new NodeSystem(this.layout);
  readonly pipes: PipeSystem;
  readonly grid = new InputGrid();
  settings: LabSettings = loadSettings();
  reduced = false;
  activations: Float32Array[] | null = null;
  schematic: SchematicPlan | null = null;

  model: ModelParams | null = null;
  samples: Sample[] = [];
  metrics: Metrics | null = null;
  scene: LabScene | null = null;
  error: string | null = null;

  private canvas: HTMLCanvasElement | null = null;
  private labels = new Map<string, HTMLElement>();
  private summary: Summary | null = null;
  private probs = new Float32Array(10);
  private hover: HitTarget | null = null;
  private inspector: InspectorData | null = null;
  private sampleMeta: { label: number; correct: boolean } | null = null;
  private cascadeStage = -1;

  private listeners = new Set<() => void>();
  /** 在构造函数末尾（pipes 就绪后）初始化 */
  private snapshot!: LabSnapshot;
  private version = 0;
  private lastEmit = 0;
  private pendingEmit: number | null = null;
  private inferTimer: number | null = null;
  private paintDirty = false;
  private perfTimer: number | null = null;

  constructor() {
    this.pipes = new PipeSystem(this.layout);
    // 管道几何需要节点当前位置：必须在第一次 replan 之前接上
    this.pipes.nodes = this.nodes;
    this.snapshot = this.buildSnapshot();
  }

  /** LabSceneHost：场景通过它读取像素格 */
  get inputGrid(): InputGrid {
    return this.grid;
  }

  /* ---------------- 初始化 ---------------- */

  async init(): Promise<void> {
    try {
      const [model, samples, metrics] = await Promise.all([loadModel(), loadSamples(), loadMetrics()]);
      this.model = model;
      this.samples = samples;
      this.metrics = metrics;
      this.replan(true);
      if (this.canvas) this.createScene();
      this.runInference();
      this.emit(true);
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.emit(true);
    }
  }

  attach(canvas: HTMLCanvasElement, labels: Map<string, HTMLElement>) {
    this.canvas = canvas;
    this.labels = labels;
    if (this.model) this.createScene();
  }

  detach() {
    this.scene?.dispose();
    this.scene = null;
    this.canvas = null;
  }

  private createScene() {
    if (!this.canvas) return;
    this.scene?.dispose();
    this.scene = new LabScene(this.canvas, this.layout, this.nodes, this.pipes, this);
    this.scene.setLabelElements(this.labels);
    this.scene.fitView(false);
    window.setTimeout(() => this.scene?.focusInput(!this.reduced), 420);
  }

  /* ---------------- 快照 / 订阅 ---------------- */

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): LabSnapshot => this.snapshot;

  private buildSnapshot(): LabSnapshot {
    const s = this.summary;
    const ink = this.grid.inkCount();
    // 空画板：不给出"预测"（偏置会让网络瞎猜一个数字，这没有教学意义，也容易误导）
    const hasInput = ink > 0;
    return {
      version: this.version,
      modelReady: this.model !== null,
      error: this.error,
      prediction: s && hasInput ? s.prediction : null,
      confidence: s && hasInput ? s.confidence : 0,
      margin: s && hasInput ? s.margin : 0,
      probs: hasInput ? Array.from(this.probs) : new Array(10).fill(0),
      top3: s && hasInput ? s.top3 : [],
      ink,
      hover: this.hover,
      hoverText: this.describeHit(this.hover),
      inspector: this.inspector,
      fps: this.scene?.fps ?? 0,
      frameMs: this.scene?.frameMs ?? 0,
      pipes: this.pipes.drawnPipes,
      particles: this.scene?.flow.count ?? 0,
      plucking: this.pipes.plucking,
      cascadeStage: this.cascadeStage,
      sampleMeta: this.sampleMeta,
      architecture: this.model?.arch ?? [],
      totalParams: this.model ? this.model.layers.reduce((a, l) => a + l.w.length + l.b.length, 0) : 0,
      settings: { ...this.settings },
      metrics: this.metrics
        ? {
            cleanTestAccuracy: this.metrics.cleanTestAccuracy,
            jitterTestAccuracy: this.metrics.jitterTestAccuracy,
            perClassAccuracy: this.metrics.perClassAccuracy,
            dataset: this.metrics.dataset,
            trainedAt: this.metrics.trainedAt,
          }
        : null,
    };
  }

  private emit(immediate = false) {
    const now = performance.now();
    const doEmit = () => {
      this.pendingEmit = null;
      this.version++;
      this.snapshot = this.buildSnapshot();
      for (const l of this.listeners) l();
    };
    if (immediate || now - this.lastEmit > 90) {
      this.lastEmit = now;
      if (this.pendingEmit !== null) {
        window.clearTimeout(this.pendingEmit);
        this.pendingEmit = null;
      }
      doEmit();
    } else if (this.pendingEmit === null) {
      this.pendingEmit = window.setTimeout(doEmit, 90);
    }
  }

  setReduced(v: boolean) {
    this.reduced = v;
    this.scene?.invalidate();
  }

  setSetting<K extends keyof LabSettings>(key: K, value: LabSettings[K]) {
    this.settings = { ...this.settings, [key]: value };
    saveSettings(this.settings);
    this.scene?.invalidate();
    this.emit(true);
  }

  resetSettings() {
    this.settings = { ...DEFAULT_SETTINGS };
    saveSettings(this.settings);
    this.scene?.invalidate();
    this.emit(true);
  }

  /* ---------------- 示意计划 ---------------- */

  /** 重新挑选显示的神经元（换数字/停笔/载入样本时） */
  private replan(newSlots: boolean) {
    if (!this.model) return;
    this.schematic = computeSchematic(this.model, this.activations, this.grid.modelInput(), this.layout, this.schematic, newSlots);
    this.pipes.setPlan(this.schematic);
  }

  /* ---------------- 场景回调 ---------------- */

  onPaintStart() {
    this.paintDirty = true;
  }

  onPaint(cx: number, cy: number, px: number, py: number, erase: boolean) {
    this.grid.stroke(px, py, cx, cy, erase ? 1.6 : 1.15, 1, erase);
    this.paintDirty = true;
    this.scheduleInference();
  }

  onPaintEnd() {
    // 只更新真实数值与能量（不播级联、不动镜头）——
    // 逐层点亮的动画只在点样本 / 点「注入能量」时播放，否则连续修改手写会被反复打断。
    this.runInference();
    this.replan(true);
  }

  onPick(hit: HitTarget | null) {
    if (hit?.kind === 'node') {
      this.scene?.setSelected(hit.index);
      this.computeInspector(hit.index);
    } else {
      this.inspector = null;
      this.scene?.setSelected(-1);
    }
    this.emit(true);
  }

  onHover(hit: HitTarget | null) {
    this.hover = hit;
    this.emit();
  }

  onCascadeStage(stage: number) {
    this.cascadeStage = stage;
    this.emit(true);
  }

  /* ---------------- 推理 ---------------- */

  private scheduleInference() {
    if (this.inferTimer !== null) return;
    this.inferTimer = window.setTimeout(() => {
      this.inferTimer = null;
      this.runInference();
    }, 45);
  }

  runInference() {
    if (!this.model) return;
    const x = this.grid.modelInput();
    const f = forwardModel(this.model, x);
    this.activations = f.a;
    this.probs = f.probs;
    this.summary = summarize(f);

    // 能量随真实贡献实时更新（槽位保持不变，避免节点跳动）
    this.replan(false);

    if (this.paintDirty && this.scene) {
      this.scene.surge(2);
      this.paintDirty = false;
    }
    if (this.inspector) this.computeInspectorByRef();
    this.scene?.invalidate();
    this.emit();
  }

  private computeInspector(nodeIdx: number) {
    const model = this.model;
    const acts = this.activations;
    const plan = this.schematic;
    if (!model || !acts || !plan) {
      this.inspector = null;
      return;
    }
    const blockIdx = this.nodes.blockOf[nodeIdx];
    const layer = blockIdx;
    if (layer < 1 || layer > model.layers.length) {
      this.inspector = null;
      return;
    }
    const slot = this.nodes.localOf[nodeIdx];
    const neuron = plan.slots[layer][slot];
    if (neuron === undefined) {
      this.inspector = null;
      return;
    }
    const wl = model.layers[layer - 1];
    const prev: ArrayLike<number> = layer === 1 ? this.grid.values : acts[layer - 2];
    const { w, c, sum, bias } = contributions(wl, neuron, prev);
    const rows: { src: number; w: number; x: number; c: number }[] = [];
    for (let i = 0; i < wl.inN; i++) rows.push({ src: i, w: w[i], x: prev[i], c: c[i] });
    rows.sort((a, b) => Math.abs(b.c) - Math.abs(a.c));
    this.inspector = {
      layer,
      slot,
      neuron,
      neuronCount: wl.outN,
      activation: acts[layer - 1][neuron],
      z: layer === model.layers.length ? acts[layer - 1][neuron] : sum - bias,
      bias,
      sum,
      contributions: rows.slice(0, 14),
      srcTotal: wl.inN,
    };
  }

  private computeInspectorByRef() {
    const sel = this.scene?.selectedIndex ?? -1;
    if (sel >= 0) this.computeInspector(sel);
  }

  /* ---------------- 命令 ---------------- */

  clear() {
    this.grid.clear();
    this.sampleMeta = null;
    this.inspector = null;
    this.scene?.setSelected(-1);
    this.runInference();
    this.replan(true);
    this.emit(true);
  }

  loadSample(sample: Sample) {
    this.grid.loadRaw14(sample.raw14);
    this.sampleMeta = { label: sample.label, correct: sample.correct };
    this.runInference();
    this.replan(true);
    this.emit(true);
    this.scene?.focusInput(!this.reduced);
    window.setTimeout(() => this.scene?.startCascade(), 260);
  }

  inject() {
    this.scene?.startCascade();
  }

  focusInput() {
    this.scene?.focusInput(!this.reduced);
  }

  fitAll() {
    this.scene?.fitView(!this.reduced);
  }

  focusBlock(index: number) {
    this.scene?.focusBlock(index, !this.reduced);
  }

  /**
   * 复位（等同刷新页面）：设置值回默认、浮窗回默认位置与开关、镜头回开场视角、
   * 球与管道归位、级联停止、选中清除。
   * **保留手写内容**（清掉手写是「🧹 清空」的职责）与"已看过引导"标记。
   */
  resetAll() {
    this.resetSettings(); // 含 localStorage
    this.inspector = null;
    this.hover = null;
    this.nodes.reset();
    this.pipes.rebuild();
    this.scene?.resetStage();
    this.scene?.resetCamera(!this.reduced);
    emitUiReset(); // 通知浮窗：丢记忆位置、展开折叠、开关回默认
    this.emit(true);
  }

  /** 只让物体归位（不动镜头与设置） */
  resetLayout() {
    this.inspector = null;
    this.nodes.reset();
    this.pipes.rebuild();
    this.scene?.resetStage();
    this.emit(true);
  }

  moveLayerDrag(dxScreen: number, dyScreen: number) {
    const k = this.scene?.camera.k ?? 1;
    const b = this.nodes.dragBlock;
    if (b < 0) return;
    this.nodes.blockOffset[b * 2] = dxScreen / k;
    this.nodes.blockOffset[b * 2 + 1] = dyScreen / k;
    this.pipes.rebuild();
    this.scene?.invalidate();
  }

  beginLayerDrag(key: string) {
    const idx = this.layout.blocks.findIndex((b) => b.key === key);
    if (idx >= 0) this.nodes.startBlockDrag(idx);
  }

  endLayerDrag() {
    this.nodes.endBlockDrag();
    this.pipes.rebuild();
  }

  setErase(v: boolean) {
    this.scene?.setEraseMode(v);
  }

  perfTick(on: boolean) {
    if (on && this.perfTimer === null) this.perfTimer = window.setInterval(() => this.emit(true), 500);
    else if (!on && this.perfTimer !== null) {
      window.clearInterval(this.perfTimer);
      this.perfTimer = null;
    }
  }

  /** 实时读数（审计与性能面板用，不经过快照节流） */
  live() {
    return {
      fps: this.scene?.fps ?? 0,
      frameMs: this.scene?.frameMs ?? 0,
      particles: this.scene?.flow.count ?? 0,
      plucking: this.pipes.plucking,
      pipes: this.pipes.drawnPipes,
      cascadeStage: this.cascadeStage,
    };
  }

  /** 输入格的屏幕坐标（自动化测试与像素矩阵联动用） */
  cellScreen(index: number): [number, number] {
    if (!this.scene) return [0, 0];
    return this.scene.camera.toScreen(this.scene.cellWorldX(index), this.scene.cellWorldY(index));
  }

  /** 悬停提示文案（真实数值） */
  private describeHit(hit: HitTarget | null): { title: string; value: string; sub?: string } | null {
    if (!hit) return null;
    const plan = this.schematic;
    const acts = this.activations;
    if (hit.kind === 'cell') {
      const r = Math.floor(hit.index / 14);
      const c = hit.index % 14;
      const v = this.grid.values[hit.index];
      return {
        title: `像素 (${r + 1}, ${c + 1})`,
        value: `灰度 ${Math.round(v * 255)}/255 · 归一化 ${v.toFixed(3)}`,
        sub: '这 196 个值就是模型的输入',
      };
    }
    if (hit.kind === 'node') {
      const layer = this.nodes.blockOf[hit.index];
      const slot = this.nodes.localOf[hit.index];
      const neuron = plan?.slots[layer]?.[slot];
      const a = acts ? acts[layer - 1] : null;
      const val = a && neuron !== undefined ? a[neuron] : 0;
      const block = this.layout.blocks[layer];
      if (layer === 4) {
        return { title: `输出节点「${neuron}」`, value: `真实概率 ${(val * 100).toFixed(2)}%`, sub: '点击看这个数字的完整计算' };
      }
      return {
        title: `${block?.label ?? '神经元'} · 真实编号 #${neuron}`,
        value: `真实激活值 ${val.toFixed(4)}`,
        sub: `该层共 ${this.model?.arch[layer] ?? 0} 个神经元，画面显示最活跃的 ${block?.count ?? 0} 个`,
      };
    }
    const b = this.layout.blocks[hit.index];
    return b ? { title: b.label, value: b.sub, sub: '拖动标签可整层移动' } : null;
  }
}

let cached: LabEngine | null = null;
export function lab(): LabEngine {
  if (!cached) cached = new LabEngine();
  return cached;
}

export type { LabEngine };

function loadSettings(): LabSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<LabSettings>) };
  } catch {
    /* 隐私模式忽略 */
  }
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(s: LabSettings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}
