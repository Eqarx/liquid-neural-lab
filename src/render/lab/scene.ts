/**
 * 实验台场景（v3 示意化）—— 单 Canvas 2D，全屏交互层。
 *
 * 绘制顺序：背景 → 层底板 → 管道（在输入层背面）→ 汇流排 → 输入像素格 →
 *           节点辉光 → 大节点（内含液体 + 真实数值）→ 能量光团 → 指针
 *
 * 交互：在输入格上直接手写、拖节点（弹簧+液体晃动）、拖整层（拖层标签）、
 *       鼠标扫过拨弯管道、滚轮/双指缩放平移、双击聚焦某层。
 */

import { frameLoop } from '../../motion/frameLoop';
import type { InputGrid } from '../../core/inputGrid';
import { cellCenter, type LabLayout } from './geometry';
import { LabCamera } from './camera';
import { FlowSystem } from './flow';
import { drawLiquidNode, NodeSystem } from './nodes';
import { PAL, glowSprite, starField } from './palette';
import { PipeSystem } from './pipes';
import type { SchematicPlan } from './schematic';

export interface HitTarget {
  kind: 'node' | 'cell' | 'block';
  index: number;
}

export interface LabSettings {
  /** 管内流体与光团的整体亮度 */
  flowBrightness: number;
  particleDensity: number;
  liquid: boolean;
  followCamera: boolean;
  showLabels: boolean;
  cascadeSpeed: number;
}

export interface LabSceneHost {
  inputGrid: InputGrid;
  settings: LabSettings;
  reduced: boolean;
  /** [a1, a2, a3, probs] */
  activations: Float32Array[] | null;
  schematic: SchematicPlan | null;
  onPaintStart(): void;
  onPaint(cx: number, cy: number, px: number, py: number, erase: boolean): void;
  onPaintEnd(): void;
  onPick(hit: HitTarget | null): void;
  onHover(hit: HitTarget | null): void;
  onCascadeStage(stage: number): void;
}

interface CascadeStage {
  t: number;
  layer: number;
  perPipe: number;
  cam: number;
}

const BRUSH_RADIUS = 1.15;
const ERASE_RADIUS = 1.6;

export class LabScene {
  readonly layout: LabLayout;
  readonly camera = new LabCamera();
  readonly nodes: NodeSystem;
  readonly pipes: PipeSystem;
  readonly flow = new FlowSystem(700);

  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private host: LabSceneHost;
  private dpr = 1;
  private w = 0;
  private h = 0;
  private ro: ResizeObserver;
  private disposed = false;

  private labels = new Map<string, HTMLElement>();
  private baseCellX = new Float32Array(196);
  private baseCellY = new Float32Array(196);

  /**
   * 指针状态：
   *  · sx/sy   —— 当前位置（画笔指示圈画在这里，每次 move 都要更新）
   *  · psx/psy —— 上一帧位置（算速度，供拨动管道用）
   *  · downX/downY —— 按下位置（判断"是否拖动过"）
   */
  private pointer = {
    sx: 0,
    sy: 0,
    psx: 0,
    psy: 0,
    downX: 0,
    downY: 0,
    vx: 0,
    vy: 0,
    pressure: 1,
    down: false,
    moved: false,
    inside: false,
  };
  private mode: 'idle' | 'paint' | 'erase' | 'node' | 'block' | 'pan' = 'idle';
  private hit: HitTarget | null = null;
  private selected = -1;
  private lastPaint: [number, number] | null = null;
  private paintCells: number[] = [];
  private pointers = new Map<number, [number, number]>();
  private pinchDist = 0;
  private pinchMid: [number, number] = [0, 0];
  private blockDragStart: [number, number] | null = null;
  /** 触摸作画：先按住不落墨，移动/抬手时才画（避免捏合手势戳出墨点） */
  private pendingPaint: { x: number; y: number; erase: boolean } | null = null;
  /** 一笔开始前的画面快照：判定为捏合手势时整体还原 */
  private strokeBackup: Float32Array | null = null;

  private cascade: { t: number; next: number; stages: CascadeStage[]; outro: number } | null = null;
  /** 级联收尾时在获胜数字上留一个脉冲环 */
  private winnerPulse: { gi: number; t: number } | null = null;

  frameMs = 0;
  fps = 0;
  private fpsAcc = 0;
  private fpsCount = 0;

  constructor(
    canvas: HTMLCanvasElement,
    layout: LabLayout,
    nodes: NodeSystem,
    pipes: PipeSystem,
    host: LabSceneHost,
  ) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D 不可用');
    this.ctx = ctx;
    this.layout = layout;
    this.nodes = nodes;
    this.pipes = pipes;
    this.host = host;

    for (let i = 0; i < 196; i++) {
      const [cx, cy] = cellCenter(layout, i);
      this.baseCellX[i] = cx;
      this.baseCellY[i] = cy;
    }
    this.pipes.nodes = this.nodes;

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas.parentElement ?? canvas);
    this.resize(true);

    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onUp);
    canvas.addEventListener('pointerleave', this.onLeave);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('dblclick', this.onDblClick);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    frameLoop.start(this.tick);
  }

  dispose() {
    this.disposed = true;
    frameLoop.stop(this.tick);
    this.ro.disconnect();
    this.canvas.removeEventListener('pointerdown', this.onDown);
    this.canvas.removeEventListener('pointermove', this.onMove);
    this.canvas.removeEventListener('pointerup', this.onUp);
    this.canvas.removeEventListener('pointercancel', this.onUp);
    this.canvas.removeEventListener('pointerleave', this.onLeave);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('dblclick', this.onDblClick);
  }

  setLabelElements(map: Map<string, HTMLElement>) {
    this.labels = map;
  }

  /* ---------------- 尺寸 ---------------- */

  private resize(force = false) {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) return;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    const pw = Math.round(rect.width * this.dpr);
    const ph = Math.round(rect.height * this.dpr);
    if (pw === this.canvas.width && ph === this.canvas.height && !force) return;
    this.canvas.width = pw;
    this.canvas.height = ph;
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;
    this.w = rect.width;
    this.h = rect.height;
    this.camera.setViewport(rect.width, rect.height);
  }

  /* ---------------- 相机 ---------------- */

  fitView(animate = true) {
    const narrow = this.w < 900;
    const usableH = narrow ? this.h * 0.5 : this.h - 150;
    const k = Math.min((this.w - (narrow ? 40 : 90)) / this.layout.totalW, usableH / this.layout.totalH);
    // 窄屏：整张网络整体上移，否则会缩在底部浮窗后面
    const screenY = 88 + usableH / 2;
    const cy = (this.h / 2 - screenY) / k;
    const target = { cx: this.layout.totalW / 2, cy, k: Math.min(k, 1.2) };
    if (this.host.reduced || !animate) this.camera.snap(target);
    else this.camera.flyTo(target, 0.8);
    this.camera.minK = Math.max(0.05, k * 0.6);
    this.invalidate();
  }

  /**
   * 当前真正能看见的纵向区间：顶栏底边 ~ 底部浮窗/工具条顶边。
   * 直接量 DOM（顶栏会因窄屏换行变高、浮窗栈也会变形），比写死像素稳。
   */
  private uiBand(): { top: number; bottom: number } {
    const topEl = document.querySelector('.topbar');
    const top = (topEl?.getBoundingClientRect().height ?? 56) + 14;
    const stack = document.querySelector('.sheet-stack');
    const dock = document.querySelector('.dock');
    let bottom = this.h - 74;
    if (stack) bottom = Math.min(bottom, stack.getBoundingClientRect().top - 8);
    else if (dock) bottom = Math.min(bottom, dock.getBoundingClientRect().top - 12);
    return { top, bottom: Math.max(top + 140, bottom) };
  }

  /**
   * 把某一层框进视野。
   *  · 宽屏：层比屏幕高，因此设了缩放下限（0.78），超出部分靠拖动查看；
   *  · 窄屏：按"可见带"缩放，保证整块输入格都露在浮窗上方（否则手指点上去会点在面板上）。
   */
  focusBlock(index: number, animate = true, zoomBias = 1) {
    const b = this.layout.blocks[index];
    const narrow = this.w < 900;
    const band = this.uiBand();
    const usableH = band.bottom - band.top;
    const kFit = Math.min((this.w - (narrow ? 40 : 150)) / b.w, usableH / b.h);
    const floor = narrow ? 0.3 : 0.78;
    const k = Math.max(0.3, Math.min(1.15, Math.max(kFit, floor) * zoomBias));
    const screenY = band.top + usableH / 2;
    const cy = b.y + (this.h / 2 - screenY) / k;
    // 宽屏时把内容左移，避开右侧的浮窗（结果面板/检查器）
    const panelBias = narrow ? 0 : 150;
    const target = { cx: b.x + panelBias / k, cy, k };
    if (this.host.reduced || !animate) this.camera.snap(target);
    else this.camera.flyTo(target, 0.75);
    this.invalidate();
  }

  focusInput(animate = true) {
    this.focusBlock(0, animate, 1);
  }

  /** 镜头回到"刚打开页面"的视角：先全览再落到输入格 */
  resetCamera(animate = true) {
    this.camera.minK = 0.05;
    this.fitView(false);
    this.focusInput(animate);
  }

  /**
   * 复位舞台：把被弄乱的**物体状态**收回原位 ——
   * 球回静止位、被拨弯的管道回正、停止正在播放的级联、清除选中与获胜脉冲。
   * 镜头与浮窗由 resetCamera / emitUiReset 负责，手写内容与设置不受影响。
   */
  resetStage() {
    this.cascade = null;
    this.winnerPulse = null;
    this.pipes.clearPluck();
    this.nodes.reset();
    this.pipes.rebuild();
    this.selected = -1;
    this.hit = null;
    this.host.onCascadeStage(-1);
    this.invalidate();
  }

  /* ---------------- 级联 ---------------- */

  /** 该层当前激活值最大的槽位 —— 能量真正汇聚的那个节点 */
  private hotSlot(layer: number): number {
    const plan = this.host.schematic;
    const acts = this.host.activations;
    if (!plan || !acts) return 0;
    const a = acts[layer - 1];
    const slots = plan.slots[layer];
    if (!a || !slots) return 0;
    let best = 0;
    let bestV = -Infinity;
    for (let s = 0; s < slots.length; s++) {
      const v = a[slots[s]] ?? 0;
      if (v > bestV) {
        bestV = v;
        best = s;
      }
    }
    return best;
  }

  /**
   * 把镜头对准某个具体节点（不是层中心）——
   * 竖列布局下层比屏幕高，只对齐层中心会让"能量的终点"跑到屏幕外。
   */
  focusNode(blockIndex: number, slot: number, animate = true) {
    const b = this.layout.blocks[blockIndex];
    if (!b || b.firstNode < 0) return;
    const gi = b.firstNode + slot;
    const narrow = this.w < 900;
    const band = this.uiBand();
    const usableH = band.bottom - band.top;
    const kFit = Math.min((this.w - (narrow ? 40 : 150)) / (b.radius * 4), usableH / (b.radius * 4));
    // 节点特写：不要贴太近，留出来路管道（讲故事更重要）
    const k = Math.max(narrow ? 0.3 : 0.72, Math.min(0.95, kFit));
    const screenY = band.top + usableH / 2;
    // 让节点落在"可见带"的中心（窄屏时屏幕中心在浮窗后面）
    const cy = this.nodes.pos[gi * 2 + 1] + (this.h / 2 - screenY) / k;
    const panelBias = narrow ? 0 : 150;
    const target = { cx: this.nodes.pos[gi * 2] + panelBias / k, cy, k };
    if (this.host.reduced || !animate) this.camera.snap(target);
    else this.camera.flyTo(target, 0.7);
    this.invalidate();
  }

  /** 级联第 stage 拍：把能量注向该层最热的节点，并让镜头对上它 */
  private cascadeStage(stageIndex: number, layer: number, perPipe: number, cam: number) {
    const slot = this.hotSlot(layer);
    if (!this.host.reduced) this.flow.wavePath(this.pipes, layer, slot, perPipe);
    if (this.host.settings.followCamera) this.focusNode(cam, slot, true);
    this.host.onCascadeStage(stageIndex);
  }

  startCascade() {
    const speed = this.host.settings.cascadeSpeed;
    const stages: CascadeStage[] = [
      { t: 0.0, layer: 1, perPipe: 4, cam: 1 },
      { t: 0.62, layer: 2, perPipe: 3, cam: 2 },
      { t: 1.18, layer: 3, perPipe: 3, cam: 3 },
      { t: 1.7, layer: 4, perPipe: 3, cam: 4 },
    ];
    for (const s of stages) s.t /= Math.max(0.35, speed);
    this.cascade = { t: 0, next: 1, stages, outro: 2.4 / Math.max(0.35, speed) };
    this.winnerPulse = null;
    this.cascadeStage(0, stages[0].layer, stages[0].perPipe, stages[0].cam);
  }

  /** 书写时的即时注入：从输入汇流排喷出一小股 */
  surge(count = 3) {
    if (this.host.reduced || this.host.settings.particleDensity <= 0) return;
    const list = this.pipes.pipes;
    for (let k = 0; k < count * 2; k++) {
      const i = Math.floor(Math.random() * list.length);
      if (list[i] && list[i].fromLayer === 0) this.flow.spawn(this.pipes, i, false, -Math.random() * 0.1);
    }
  }

  addPaintedCells(cells: number[]) {
    for (const c of cells) if (!this.paintCells.includes(c)) this.paintCells.push(c);
  }

  takePaintedCells(): number[] {
    const c = this.paintCells;
    this.paintCells = [];
    return c;
  }

  /* ---------------- 命中测试 ---------------- */

  hitTest(sx: number, sy: number): HitTarget | null {
    const [wx, wy] = this.camera.toWorld(sx, sy);
    const node = this.nodes.hitTest(wx, wy, 6 / this.camera.k);
    if (node >= 0) return { kind: 'node', index: node };
    const input = this.layout.blocks[0];
    if (
      wx >= input.x - input.w / 2 - 8 &&
      wx <= input.x + input.w / 2 + 8 &&
      wy >= input.y - input.h / 2 - 8 &&
      wy <= input.y + input.h / 2 + 8
    ) {
      const c = Math.floor((wx - (this.baseCellX[0] - this.layout.inputCell / 2)) / this.layout.inputCell);
      const r = Math.floor((wy - (this.baseCellY[0] - this.layout.inputCell / 2)) / this.layout.inputCell);
      if (c >= 0 && c < 14 && r >= 0 && r < 14) return { kind: 'cell', index: r * 14 + c };
      return { kind: 'block', index: 0 };
    }
    for (let i = 1; i < this.layout.blocks.length; i++) {
      const b = this.layout.blocks[i];
      if (Math.abs(wx - b.x) <= b.w / 2 + 20 && Math.abs(wy - b.y) <= b.h / 2 + 20) {
        return { kind: 'block', index: i };
      }
    }
    return null;
  }

  /* ---------------- 指针 ---------------- */

  private local(e: PointerEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  private onDown = (e: PointerEvent) => {
    // 中键：避免浏览器的"自动滚动"圆盘
    if (e.button === 1) e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    const [sx, sy] = this.local(e);
    this.pointers.set(e.pointerId, [sx, sy]);
    this.pointer.down = true;
    this.pointer.moved = false;
    this.pointer.sx = sx;
    this.pointer.sy = sy;
    this.pointer.psx = sx;
    this.pointer.psy = sy;
    this.pointer.downX = sx;
    this.pointer.downY = sy;
    // 触控笔压力 → 笔刷粗细（0.6×~1.5×）
    this.pointer.pressure = e.pointerType === 'pen' && e.pressure > 0 ? 0.6 + e.pressure * 0.9 : 1;

    if (this.pointers.size === 2) {
      // 第二根手指落下：如果刚才是"单指作画"，撤销这一笔（捏合缩放不该留下墨点）
      if ((this.mode === 'paint' || this.mode === 'erase') && this.strokeBackup) {
        this.host.inputGrid.values.set(this.strokeBackup);
        this.strokeBackup = null;
        this.pendingPaint = null;
        this.lastPaint = null;
        this.host.onPaintEnd();
      }
      const pts = [...this.pointers.values()];
      this.pinchDist = Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]);
      this.pinchMid = [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2];
      this.mode = 'pan';
      return;
    }
    if (this.pointers.size > 2) return;

    const hit = this.hitTest(sx, sy);
    if (hit?.kind === 'cell' || (hit?.kind === 'block' && hit.index === 0)) {
      const erase = this.eraseMode || e.button === 2 || e.shiftKey;
      this.mode = erase ? 'erase' : 'paint';
      this.lastPaint = null;
      // 记下这一笔开始前的画面：若被判定为"捏合手势"就整体还原
      this.strokeBackup = new Float32Array(this.host.inputGrid.values);
      if (e.pointerType === 'touch') {
        // 触摸先不落墨，等移动或抬手（见 onMove / onUp）
        this.pendingPaint = { x: sx, y: sy, erase };
      } else {
        this.host.onPaintStart();
        this.paintAt(sx, sy, erase);
      }
      return;
    }
    if (hit?.kind === 'node') {
      const [wx, wy] = this.camera.toWorld(sx, sy);
      this.nodes.startNodeDrag(hit.index, wx, wy);
      this.selected = hit.index;
      this.mode = 'node';
      return;
    }
    if (hit?.kind === 'block') {
      this.nodes.startBlockDrag(hit.index);
      this.blockDragStart = [sx, sy];
      this.mode = 'block';
      return;
    }
    this.mode = 'pan';
  };

  private onMove = (e: PointerEvent) => {
    const [sx, sy] = this.local(e);
    const prev = this.pointers.get(e.pointerId);
    if (prev) this.pointers.set(e.pointerId, [sx, sy]);
    this.pointer.inside = true;
    const dx = sx - this.pointer.psx;
    const dy = sy - this.pointer.psy;
    this.pointer.vx = dx;
    this.pointer.vy = dy;
    // 当前位置：画笔/橡皮指示圈画在这里（必须每次 move 更新）
    this.pointer.sx = sx;
    this.pointer.sy = sy;
    this.pointer.psx = sx;
    this.pointer.psy = sy;
    if (Math.abs(sx - this.pointer.downX) + Math.abs(sy - this.pointer.downY) > 3) this.pointer.moved = true;
    this.invalidate(); // 指示圈要跟着指针走

    if (this.pointers.size === 2) {
      const pts = [...this.pointers.values()];
      const d = Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]);
      const mid: [number, number] = [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2];
      if (this.pinchDist > 0) {
        // 缩放与平移一体：内容严格跟手（不用弹簧，否则"边捏边移"会跟不动）
        this.camera.pinchTo(mid[0], mid[1], this.pinchMid[0], this.pinchMid[1], d / this.pinchDist);
      }
      this.pinchDist = d;
      this.pinchMid = mid;
      return;
    }

    // 拨弯管道
    if (!this.host.reduced && Math.abs(dx) + Math.abs(dy) > 0.5) {
      const [wx, wy] = this.camera.toWorld(sx, sy);
      this.pipes.pluck(wx, wy, (dx / this.camera.k) * 60, (dy / this.camera.k) * 60, 42 / this.camera.k);
    }

    if (this.mode === 'paint' || this.mode === 'erase') {
      // 触摸：第一根手指先不落墨，等真的移动了（或抬手时补一个点）再画，
      // 这样"两指捏合缩放"不会先在画板上戳出一个点。
      if (this.pendingPaint) {
        const far = Math.abs(sx - this.pendingPaint.x) + Math.abs(sy - this.pendingPaint.y) > 3;
        if (!far && e.pointerType === 'touch') return;
        this.host.onPaintStart();
        this.paintAt(this.pendingPaint.x, this.pendingPaint.y, this.pendingPaint.erase);
        this.pendingPaint = null;
      }
      this.paintAt(sx, sy, this.mode === 'erase');
      return;
    }
    if (this.mode === 'node') {
      const [wx, wy] = this.camera.toWorld(sx, sy);
      this.nodes.moveDrag(wx, wy);
      this.pipes.rebuild();
      return;
    }
    if (this.mode === 'block' && this.blockDragStart) {
      this.nodes.moveBlockDrag((sx - this.blockDragStart[0]) / this.camera.k, (sy - this.blockDragStart[1]) / this.camera.k);
      this.pipes.rebuild();
      return;
    }
    if (this.mode === 'pan') {
      this.camera.panBy(dx, dy, performance.now());
      return;
    }
    // 触摸没有"悬停"概念：不做 hover 提示，免得浮层留在屏幕上不消失
    if (e.pointerType === 'mouse' || e.pointerType === 'pen') {
      const hit = this.hitTest(sx, sy);
      if (!sameHit(hit, this.hit)) {
        this.hit = hit;
        this.host.onHover(hit);
      }
      this.updateCursor(hit);
    }
  };

  private onUp = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinchDist = 0;
    const wasPainting = this.mode === 'paint' || this.mode === 'erase';
    const wasNode = this.mode === 'node';
    const picked = this.selected;
    const moved = this.pointer.moved;
    if (this.mode === 'node') this.nodes.endNodeDrag();
    if (this.mode === 'block') {
      this.nodes.endBlockDrag();
      this.blockDragStart = null;
    }
    if (this.mode === 'pan') this.camera.endPan(this.host.reduced);
    this.pointer.down = false;
    this.mode = 'idle';
    if (wasPainting) {
      // 轻点一下（没有移动）也要落下一个点
      if (!moved && this.pendingPaint) {
        this.host.onPaintStart();
        this.paintAt(this.pendingPaint.x, this.pendingPaint.y, this.pendingPaint.erase);
      }
      this.pendingPaint = null;
      this.strokeBackup = null;
      this.lastPaint = null;
      this.host.onPaintEnd();
    }
    if (wasNode && !moved && picked >= 0) {
      this.host.onPick({ kind: 'node', index: picked });
    }
    this.invalidate();
  };

  private onLeave = () => {
    this.pointer.inside = false;
    if (this.hit) {
      this.hit = null;
      this.host.onHover(null);
    }
  };

  /**
   * 滚轮 / 触控板。
   *
   * 设备判定：同一个"滚动会话"（相邻事件间隔 < 260ms）内只判定一次，整串行为一致 ——
   * 之前按单事件猜（deltaY % 40）会让 Windows 鼠标滚轮（deltaY=100）时而平移时而缩放。
   *   · Ctrl/⌘+滚轮、触控板捏合 → 缩放
   *   · 传统鼠标滚轮（离散大步进 / wheelDeltaY 是 120 的整数倍）→ 缩放
   *   · 触控板双指滚动 → 平移（文档语义：向下滚 = 内容上移，与浏览器滚动一致）
   */
  private wheelSession = { last: 0, device: 'mouse' as 'mouse' | 'trackpad' };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const r = this.canvas.getBoundingClientRect();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
    const dx = e.deltaX * unit;
    const dy = e.deltaY * unit;
    if (e.ctrlKey || e.metaKey) {
      // 触控板捏合 / Ctrl+滚轮：始终缩放
      this.camera.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-dy * 0.01), this.host.reduced);
      this.invalidate();
      return;
    }
    const now = performance.now();
    if (now - this.wheelSession.last > 260) {
      const wheelDelta = (e as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY;
      const discrete = typeof wheelDelta === 'number' && Math.abs(wheelDelta) >= 100 && Math.abs(wheelDelta % 120) <= 1;
      const bigStep = Math.abs(dy) >= 90 && Math.abs(e.deltaX) < 0.5;
      this.wheelSession.device = e.deltaMode !== 0 || discrete || bigStep ? 'mouse' : 'trackpad';
    }
    this.wheelSession.last = now;
    if (this.wheelSession.device === 'mouse') {
      this.camera.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-dy * 0.0016), this.host.reduced);
    } else {
      // 文档语义：滚轮向下 = 视口下移（内容上移）；不加惯性，触控板本身已是平滑步进
      this.camera.panBy(-dx, -dy, now, false);
    }
    this.invalidate();
  };

  private onDblClick = (e: MouseEvent) => {
    const r = this.canvas.getBoundingClientRect();
    const hit = this.hitTest(e.clientX - r.left, e.clientY - r.top);
    if (hit?.kind === 'node') this.focusBlock(this.nodes.blockOf[hit.index], true, 1);
  };

  private paintAt(sx: number, sy: number, erase: boolean) {
    const [wx, wy] = this.camera.toWorld(sx, sy);
    const cell = (wx - this.baseCellX[0]) / this.layout.inputCell + 0.5;
    const row = (wy - this.baseCellY[0]) / this.layout.inputCell + 0.5;
    // 触控笔按压力度微调笔尖粗细（鼠标/手指 = 1）
    const radius = (erase ? ERASE_RADIUS : BRUSH_RADIUS) * this.pointer.pressure;
    if (this.lastPaint) this.host.onPaint(cell, row, this.lastPaint[0], this.lastPaint[1], erase);
    else this.host.onPaint(cell, row, cell, row, erase);
    const c0 = Math.max(0, Math.floor(cell - radius));
    const c1 = Math.min(13, Math.ceil(cell + radius));
    const r0 = Math.max(0, Math.floor(row - radius));
    const r1 = Math.min(13, Math.ceil(row + radius));
    const cells: number[] = [];
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) cells.push(r * 14 + c);
    this.addPaintedCells(cells);
    this.lastPaint = [cell, row];
  }

  private updateCursor(hit: HitTarget | null) {
    const c = this.canvas.style;
    if (this.mode === 'pan') c.cursor = 'grabbing';
    else if (hit?.kind === 'cell' || (hit?.kind === 'block' && hit.index === 0)) c.cursor = 'crosshair';
    else if (hit?.kind === 'node') c.cursor = 'grab';
    else c.cursor = 'grab';
  }

  setSelected(idx: number) {
    this.selected = idx;
  }

  /** 输入格世界坐标（含输入层底板偏移）—— 供像素矩阵联动与自动化测试取样 */
  cellWorldX(i: number): number {
    return this.baseCellX[i];
  }
  cellWorldY(i: number): number {
    return this.baseCellY[i];
  }

  get selectedIndex() {
    return this.selected;
  }

  eraseMode = false;
  setEraseMode(v: boolean) {
    this.eraseMode = v;
  }

  /* ---------------- 帧循环 ---------------- */

  private tick = (dt: number) => {
    if (this.disposed) return;
    const t0 = performance.now();
    let dirty = false;
    if (this.camera.step(dt, this.host.reduced)) dirty = true;
    if (this.nodes.step(dt)) {
      dirty = true;
      this.pipes.rebuild();
    }
    this.pipes.step(dt);
    if (this.pipes.plucking > 0) dirty = true;
    if (this.winnerPulse) {
      this.winnerPulse.t += dt;
      if (this.winnerPulse.t > 2.6) this.winnerPulse = null;
      else dirty = true;
    }

    if (this.cascade) {
      const speed = Math.max(0.35, this.host.settings.cascadeSpeed);
      this.cascade.t += dt * speed;
      while (this.cascade.next < this.cascade.stages.length && this.cascade.t >= this.cascade.stages[this.cascade.next].t) {
        const st = this.cascade.stages[this.cascade.next];
        this.cascadeStage(this.cascade.next, st.layer, st.perPipe, st.cam);
        this.cascade.next++;
      }
      if (this.cascade.next >= this.cascade.stages.length && this.cascade.t > this.cascade.outro) {
        // 收尾：把镜头锁在获胜数字上，并给它一个持久的脉冲环
        const winner = this.hotSlot(4);
        const outBlock = this.layout.blocks[4];
        if (outBlock.firstNode >= 0) {
          this.nodes.impulse(outBlock.firstNode + winner, 1.0);
          this.winnerPulse = { gi: outBlock.firstNode + winner, t: 0 };
          if (this.host.settings.followCamera) this.focusNode(4, winner, true);
        }
        this.host.onCascadeStage(4);
        this.cascade = null;
      }
      dirty = true;
    }

    if (!this.host.reduced) {
      const density = this.host.settings.particleDensity;
      const plan = this.host.schematic;
      const activity = plan ? plan.inputEnergy : 0;
      const rate = density * (14 + 90 * activity);
      if (rate > 1) {
        this.flow.ambient(dt, rate, this.pipes);
        dirty = true;
      }
    }
    if (this.flow.count > 0) {
      this.flow.update(dt, this.pipes, {
        onArrive: (layer, slot, isWave) => this.onParticleArrive(layer, slot, isWave),
      });
      dirty = true;
    }

    const ox = this.nodes.blockOffset[0];
    const oy = this.nodes.blockOffset[1];
    if (ox !== 0 || oy !== 0 || this.cellOffsetDirty) {
      for (let i = 0; i < 196; i++) {
        this.baseCellX[i] = this.layout.inputX0 + ((i % 14) + 0.5) * this.layout.inputCell + ox;
        this.baseCellY[i] = this.layout.inputY0 + (Math.floor(i / 14) + 0.5) * this.layout.inputCell + oy;
      }
      this.cellOffsetDirty = false;
      dirty = true;
    }

    if (dirty || this.needsRepaint) {
      this.needsRepaint = false;
      this.draw();
    }
    this.frameMs = performance.now() - t0;
    this.fpsAcc += dt;
    this.fpsCount++;
    if (this.fpsAcc > 0.5) {
      this.fps = this.fpsCount / this.fpsAcc;
      this.fpsAcc = 0;
      this.fpsCount = 0;
    }
  };

  private cellOffsetDirty = true;
  invalidate() {
    this.needsRepaint = true;
  }
  private needsRepaint = true;

  /** 光团到达：节点闪光 + 液面冲击 */
  private onParticleArrive(layer: number, slot: number, isWave: boolean) {
    const block = this.layout.blocks[layer];
    if (!block || block.firstNode < 0) return;
    const gi = block.firstNode + slot;
    this.nodes.impulse(gi, isWave ? 0.7 : 0.2);
  }

  /* ---------------- 绘制 ---------------- */

  private draw() {
    const ctx = this.ctx;
    const { camera } = this;
    const w = this.w;
    const h = this.h;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = PAL.bg;
    ctx.fillRect(0, 0, w, h);

    const bgGlow = ctx.createRadialGradient(w * 0.42, h * 0.5, 0, w * 0.42, h * 0.5, Math.max(w, h) * 0.75);
    bgGlow.addColorStop(0, PAL.bgGlow);
    bgGlow.addColorStop(0.55, 'rgba(10, 26, 40, 0.28)');
    bgGlow.addColorStop(1, 'rgba(7, 17, 32, 0)');
    ctx.fillStyle = bgGlow;
    ctx.fillRect(0, 0, w, h);

    ctx.setTransform(
      this.dpr * camera.k, 0, 0, this.dpr * camera.k,
      this.dpr * (w / 2 - camera.x * camera.k),
      this.dpr * (h / 2 - camera.y * camera.k),
    );

    const stars = starField();
    ctx.fillStyle = 'rgba(180, 230, 240, 0.5)';
    for (let i = 0; i < stars.length; i += 3) {
      const s = stars[i + 2] / camera.k;
      ctx.globalAlpha = 0.2 + stars[i + 2] * 0.4;
      ctx.fillRect(stars[i], stars[i + 1], s, s);
    }
    ctx.globalAlpha = 1;

    this.drawPlates(ctx);
    // 管道在输入层之前绘制 → 从"背面/侧面"接出，不遮挡像素格
    this.pipes.draw(ctx, camera.k, this.host.settings.flowBrightness);
    this.drawManifold(ctx);
    this.drawInputCells(ctx);
    this.drawNodeGlow(ctx);
    this.drawNodes(ctx);
    if (!this.host.reduced) this.flow.draw(ctx, camera.k, this.pipes, this.host.settings.flowBrightness);
    this.drawPointer(ctx);
    this.updateLabels();
  }

  private drawPlates(ctx: CanvasRenderingContext2D) {
    for (const b of this.layout.blocks) {
      const pad = b.key === 'input' ? 40 : 56;
      ctx.beginPath();
      roundRect(ctx, b.x - b.w / 2 - pad, b.y - b.h / 2 - pad, b.w + pad * 2, b.h + pad * 2, 26);
      ctx.fillStyle = PAL.plate;
      ctx.fill();
      ctx.strokeStyle = PAL.plateLine;
      ctx.lineWidth = 1 / this.camera.k;
      ctx.stroke();
    }
  }

  /** 汇流排：输入层背面的一根竖管，所有 L1 管道从这里出发 */
  private drawManifold(ctx: CanvasRenderingContext2D) {
    const L = this.layout;
    const x = L.manifoldX;
    const hh = L.manifoldH / 2;
    ctx.beginPath();
    roundRect(ctx, x - 13, -hh, 26, L.manifoldH, 13);
    ctx.fillStyle = PAL.pipeCasing;
    ctx.fill();
    ctx.strokeStyle = 'rgba(150, 220, 200, 0.35)';
    ctx.lineWidth = 1.5 / this.camera.k;
    ctx.stroke();
    // 流动的液面
    const plan = this.host.schematic;
    const e = plan ? plan.inputEnergy : 0;
    if (e > 0.02) {
      const grad = ctx.createLinearGradient(0, -hh, 0, hh);
      grad.addColorStop(0, `rgba(${PAL.pipeCore}, ${(0.55 * e).toFixed(3)})`);
      grad.addColorStop(1, `rgba(${PAL.pipeCore}, ${(0.15 * e).toFixed(3)})`);
      ctx.beginPath();
      roundRect(ctx, x - 9, -hh + 4, 18, L.manifoldH - 8, 9);
      ctx.fillStyle = grad;
      ctx.fill();
    }
  }

  private drawInputCells(ctx: CanvasRenderingContext2D) {
    const values = this.host.inputGrid.values;
    const cell = this.layout.inputCell;
    const gap = cell * 0.14;
    const half = cell / 2 - gap;
    const k = this.camera.k;
    for (let i = 0; i < 196; i++) {
      const v = values[i];
      const cx = this.baseCellX[i];
      const cy = this.baseCellY[i];
      ctx.beginPath();
      roundRect(ctx, cx - half, cy - half, half * 2, half * 2, Math.min(7, half * 0.5));
      ctx.fillStyle = `rgba(${PAL.ink}, ${(0.035 + 0.5 * v).toFixed(3)})`;
      ctx.fill();
      ctx.strokeStyle = `rgba(${PAL.ink}, ${(0.1 + 0.5 * v).toFixed(3)})`;
      ctx.lineWidth = 0.9 / k;
      ctx.stroke();
      if (v > 0.3) {
        const sprite = glowSprite(PAL.ink, 0.5);
        const r = half * (1.5 + v);
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = (v - 0.3) * 0.45;
        ctx.drawImage(sprite, cx - r, cy - r, r * 2, r * 2);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      }
    }
  }

  private drawNodeGlow(ctx: CanvasRenderingContext2D) {
    const plan = this.host.schematic;
    const acts = this.host.activations;
    const nodes = this.nodes;
    if (!plan || !acts) return;
    ctx.globalCompositeOperation = 'lighter';
    for (let layer = 1; layer <= 4; layer++) {
      const block = this.layout.blocks[layer];
      const a = acts[layer - 1];
      const slots = plan.slots[layer];
      let maxA = 1e-6;
      for (const idx of slots) if (a[idx] > maxA) maxA = a[idx];
      for (let s = 0; s < slots.length; s++) {
        const gi = block.firstNode + s;
        const norm = a[slots[s]] / maxA;
        const level = Math.max(norm * 0.7, nodes.flash[gi] * 0.8);
        if (level < 0.05) continue;
        const sprite = glowSprite(layer === 4 ? PAL.pos : PAL.liquid, 0.5);
        const r = nodes.radius[gi] * (1.25 + level * 0.75);
        ctx.globalAlpha = Math.min(0.6, level * 0.6);
        ctx.drawImage(sprite, nodes.pos[gi * 2] - r, nodes.pos[gi * 2 + 1] - r, r * 2, r * 2);
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  private drawNodes(ctx: CanvasRenderingContext2D) {
    const plan = this.host.schematic;
    const acts = this.host.activations;
    const nodes = this.nodes;
    const k = this.camera.k;
    const liquidOn = this.host.settings.liquid;

    // 液位目标 = 该层激活值（层内归一化 + 非线性压缩，避免每个球都灌满）
    for (let layer = 1; layer <= 4; layer++) {
      const block = this.layout.blocks[layer];
      const a = acts ? acts[layer - 1] : null;
      const slots = plan?.slots[layer] ?? [];
      let maxA = 1e-6;
      if (a) for (const idx of slots) if (a[idx] > maxA) maxA = a[idx];
      for (let s = 0; s < block.count; s++) {
        const gi = block.firstNode + s;
        const realIdx = slots[s];
        const val = a && realIdx !== undefined ? a[realIdx] : 0;
        const norm = Math.min(1, val / (maxA * 1.15));
        nodes.levelTarget[gi] = liquidOn ? Math.min(0.82, 0.05 + 0.77 * Math.pow(norm, 0.62)) : 0;
      }
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let i = 0; i < nodes.pos.length / 2; i++) {
      const layer = nodes.blockOf[i];
      const x = nodes.pos[i * 2];
      const y = nodes.pos[i * 2 + 1];
      const r = nodes.radius[i];
      const isOut = layer === 4;
      drawLiquidNode(
        ctx,
        x,
        y,
        r,
        nodes.level[i],
        nodes.tilt[i],
        nodes.slosh[i],
        nodes.sloshPhase[i],
        isOut ? PAL.liquidOut : PAL.liquid,
        isOut ? 0.34 : 0.22,
      );

      // 能量到达时的冲击环
      if (nodes.flash[i] > 0.05) {
        ctx.beginPath();
        ctx.arc(x, y, r * (1 + nodes.flash[i] * 0.22), 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(214, 255, 226, ${(nodes.flash[i] * 0.6).toFixed(3)})`;
        ctx.lineWidth = (3 + nodes.flash[i] * 6) / k;
        ctx.stroke();
      }

      // 真实数值标签（节点在屏幕上太小时不画，避免糊成一团）
      if (this.host.settings.showLabels && r * k > 30) {
        const realIdx = plan?.slots[layer]?.[nodes.localOf[i]];
        const a = acts ? acts[layer - 1] : null;
        const val = a && realIdx !== undefined ? a[realIdx] : 0;
        if (isOut) {
          ctx.font = `700 ${(r * 0.44).toFixed(1)}px "Space Grotesk", "PingFang SC", sans-serif`;
          ctx.lineWidth = r * 0.09;
          ctx.strokeStyle = 'rgba(3, 16, 10, 0.75)';
          ctx.strokeText(String(realIdx ?? ''), x, y - r * 0.08);
          ctx.fillStyle = '#f2fff6';
          ctx.fillText(String(realIdx ?? ''), x, y - r * 0.08);
          const p = acts ? acts[3][realIdx ?? 0] : 0;
          ctx.font = `600 ${(r * 0.17).toFixed(1)}px "JetBrains Mono", monospace`;
          ctx.lineWidth = r * 0.05;
          ctx.strokeStyle = 'rgba(3, 16, 10, 0.75)';
          ctx.strokeText(`${(p * 100).toFixed(1)}%`, x, y + r * 0.34);
          ctx.fillStyle = 'rgba(244, 255, 248, 0.95)';
          ctx.fillText(`${(p * 100).toFixed(1)}%`, x, y + r * 0.34);
        } else {
          ctx.font = `700 ${(r * 0.26).toFixed(1)}px "Space Grotesk", "PingFang SC", sans-serif`;
          ctx.lineWidth = r * 0.07;
          ctx.strokeStyle = 'rgba(3, 16, 10, 0.7)';
          ctx.strokeText(val.toFixed(2), x, y + r * 0.06);
          ctx.fillStyle = '#f2fff6';
          ctx.fillText(val.toFixed(2), x, y + r * 0.06);
          ctx.font = `500 ${(r * 0.13).toFixed(1)}px "JetBrains Mono", monospace`;
          ctx.lineWidth = r * 0.045;
          ctx.strokeStyle = 'rgba(3, 16, 10, 0.7)';
          ctx.strokeText(`#${realIdx ?? '-'}`, x, y + r * 0.6);
          ctx.fillStyle = 'rgba(206, 240, 224, 0.85)';
          ctx.fillText(`#${realIdx ?? '-'}`, x, y + r * 0.6);
        }
      }

      if (i === this.selected) {
        ctx.beginPath();
        ctx.arc(x, y, r + 8 / k, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${PAL.signal}, 0.9)`;
        ctx.lineWidth = 3 / k;
        ctx.stroke();
      }
      if (this.hit?.kind === 'node' && this.hit.index === i) {
        ctx.beginPath();
        ctx.arc(x, y, r + 5 / k, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,255,255,0.8)';
        ctx.lineWidth = 2 / k;
        ctx.stroke();
      }
    }
  }

  private drawPointer(ctx: CanvasRenderingContext2D) {
    // 级联收尾：在获胜数字上留一个扩散的脉冲环（明确"能量汇聚到这里"）
    if (this.winnerPulse) {
      const { gi, t } = this.winnerPulse;
      const x = this.nodes.pos[gi * 2];
      const y = this.nodes.pos[gi * 2 + 1];
      const r0 = this.nodes.radius[gi];
      const k = this.camera.k;
      for (let ring = 0; ring < 2; ring++) {
        const phase = Math.min(1, Math.max(0, (t - ring * 0.45) / 1.5));
        if (phase <= 0 || phase >= 1) continue;
        const alpha = (1 - phase) * 0.75;
        ctx.beginPath();
        ctx.arc(x, y, r0 * (1.02 + phase * 0.55), 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(190, 255, 210, ${alpha.toFixed(3)})`;
        ctx.lineWidth = (2 + (1 - phase) * 5) / k;
        ctx.stroke();
      }
      const fade = 1 - Math.min(1, t / 2.6);
      const sprite = glowSprite(PAL.liquid, 0.5);
      const rr = r0 * 2.1;
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.32 * fade;
      ctx.drawImage(sprite, x - rr, y - rr, rr * 2, rr * 2);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }
    if (!this.pointer.inside) return;
    const [wx, wy] = this.camera.toWorld(this.pointer.sx, this.pointer.sy);
    const k = this.camera.k;
    const onInput =
      this.hit?.kind === 'cell' || (this.hit?.kind === 'block' && this.hit.index === 0) || this.mode === 'paint' || this.mode === 'erase';
    const sprite = glowSprite(PAL.signal, 0.5);
    const r = 44 / k;
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.14;
    ctx.drawImage(sprite, wx - r, wy - r, r * 2, r * 2);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    if (onInput) {
      ctx.beginPath();
      ctx.arc(wx, wy, BRUSH_RADIUS * this.layout.inputCell, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(190, 255, 210, 0.6)';
      ctx.lineWidth = 2 / k;
      ctx.stroke();
    }
  }

  private updateLabels() {
    if (this.labels.size === 0) return;
    for (let i = 0; i < this.layout.blocks.length; i++) {
      const b = this.layout.blocks[i];
      const el = this.labels.get(b.key);
      if (!el) continue;
      const ox = this.nodes.blockOffset[i * 2];
      const oy = this.nodes.blockOffset[i * 2 + 1];
      const [sx, syRaw] = this.camera.toScreen(b.x + ox, b.y - b.h / 2 - 54 + oy);
      const sy = Math.max(78, Math.min(this.h - 96, syRaw));
      const visible = this.host.settings.showLabels && sx > -200 && sx < this.w + 200;
      el.style.opacity = visible ? '1' : '0';
      el.style.transform = `translate(${Math.round(sx)}px, ${Math.round(sy)}px) translate(-50%, -50%)`;
    }
  }
}

function sameHit(a: HitTarget | null, b: HitTarget | null) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.kind === b.kind && a.index === b.index;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}
