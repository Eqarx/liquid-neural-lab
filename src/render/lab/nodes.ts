/**
 * 节点系统 —— 圆节点 + 内部液体 + 弹簧物理。
 *
 * 物理：
 *  - 每个节点被弹簧拉回静止位（欠阻尼，松手后有回弹）；
 *  - 拖动某个节点时，同层邻居被"膜"带着偏移（高斯衰减），松手后像水波一样回位；
 *  - 拖动整层（拖层标签）时整块位移，松手整体回弹；
 *  - 液体液面倾斜由节点加速度决定（像容器里的水），并叠加行进波形成晃荡。
 */

import type { LabLayout } from './geometry';
import { NODE_TOTAL } from './geometry';
import { PAL } from './palette';

const K_NODE = 150;
const D_NODE = 15;
const K_DRAG = 30;
const MEMBRANE_SIGMA = 1.6;
const MEMBRANE_GAIN = 0.62;
const K_LEVEL = 120;
const D_LEVEL = 12;

export class NodeSystem {
  pos: Float32Array;
  vel: Float32Array;
  rest: Float32Array;
  radius: Float32Array;
  blockOf: Uint8Array;
  localOf: Uint16Array;
  blockCols: Uint8Array;
  blockRows: Uint8Array;

  /** 每层的整体偏移（拖动整层用），索引 = block 序号（0=输入层沿用但无节点） */
  blockOffset: Float32Array;
  blockVel: Float32Array;

  /** 液体 */
  level: Float32Array;
  levelTarget: Float32Array;
  levelVel: Float32Array;
  slosh: Float32Array;
  sloshPhase: Float32Array;
  flash: Float32Array;
  tilt: Float32Array;

  dragIdx = -1;
  dragBlock = -1;
  private dragPointer: [number, number] = [0, 0];
  private membrane = new Float32Array(NODE_TOTAL * 2);
  private membraneOn = false;

  constructor(layout: LabLayout) {
    this.pos = new Float32Array(layout.nodeRest);
    this.rest = new Float32Array(layout.nodeRest);
    this.vel = new Float32Array(NODE_TOTAL * 2);
    this.radius = new Float32Array(layout.nodeRadius);
    this.blockOf = new Uint8Array(layout.nodeBlock);
    this.localOf = new Uint16Array(layout.nodeLocal);
    this.blockCols = new Uint8Array(layout.blocks.length);
    this.blockRows = new Uint8Array(layout.blocks.length);
    layout.blocks.forEach((b, i) => {
      this.blockCols[i] = b.cols;
      this.blockRows[i] = b.rows;
    });
    this.blockOffset = new Float32Array(layout.blocks.length * 2);
    this.blockVel = new Float32Array(layout.blocks.length * 2);
    this.level = new Float32Array(NODE_TOTAL);
    this.levelTarget = new Float32Array(NODE_TOTAL);
    this.levelVel = new Float32Array(NODE_TOTAL);
    this.slosh = new Float32Array(NODE_TOTAL);
    this.sloshPhase = new Float32Array(NODE_TOTAL);
    this.flash = new Float32Array(NODE_TOTAL);
    this.tilt = new Float32Array(NODE_TOTAL);
  }

  reset() {
    this.pos.set(this.rest);
    this.vel.fill(0);
    this.blockOffset.fill(0);
    this.blockVel.fill(0);
    this.membrane.fill(0);
    this.membraneOn = false;
    this.dragIdx = -1;
    this.dragBlock = -1;
  }

  /** 命中测试：返回节点下标或 -1 */
  hitTest(wx: number, wy: number, pad: number): number {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < NODE_TOTAL; i++) {
      const dx = wx - this.pos[i * 2];
      const dy = wy - this.pos[i * 2 + 1];
      const r = this.radius[i] + pad;
      const d2 = dx * dx + dy * dy;
      if (d2 <= r * r && d2 < bestD) {
        bestD = d2;
        best = i;
      }
    }
    return best;
  }

  startNodeDrag(idx: number, wx: number, wy: number) {
    this.dragIdx = idx;
    this.dragPointer = [wx, wy];
    // 让被拖节点瞬间跟手
    this.pos[idx * 2] = wx;
    this.pos[idx * 2 + 1] = wy;
  }

  moveDrag(wx: number, wy: number) {
    this.dragPointer = [wx, wy];
  }

  endNodeDrag() {
    this.dragIdx = -1;
    this.membraneOn = false;
    this.membrane.fill(0);
  }

  startBlockDrag(blockIdx: number) {
    this.dragBlock = blockIdx;
  }

  moveBlockDrag(dx: number, dy: number) {
    if (this.dragBlock < 0) return;
    this.blockOffset[this.dragBlock * 2] = dx;
    this.blockOffset[this.dragBlock * 2 + 1] = dy;
  }

  endBlockDrag() {
    this.dragBlock = -1;
  }

  /** 液体冲击：波形 + 液面抬升（能量粒子到达时调用） */
  impulse(idx: number, amount: number) {
    if (idx < 0 || idx >= NODE_TOTAL) return;
    this.slosh[idx] = Math.min(1.6, this.slosh[idx] + amount);
    this.flash[idx] = Math.min(1.6, this.flash[idx] + amount * 0.8);
    this.levelVel[idx] += amount * 0.9;
  }

  flashNode(idx: number, amount: number) {
    if (idx < 0 || idx >= NODE_TOTAL) return;
    this.flash[idx] = Math.min(1.6, this.flash[idx] + amount);
  }

  /** 步进物理。返回是否有节点/液体仍在运动（决定是否需要重绘）。 */
  step(dt: number): boolean {
    const h = Math.min(dt, 1 / 30);
    const n = NODE_TOTAL;
    let moved = this.dragIdx >= 0 || this.dragBlock >= 0 || this.membraneOn;

    // 被拖节点：高增益跟随（跟手），并记录速度
    if (this.dragIdx >= 0) {
      const i = this.dragIdx;
      const a = 1 - Math.exp(-K_DRAG * h);
      const nx = this.pos[i * 2] + (this.dragPointer[0] - this.pos[i * 2]) * a;
      const ny = this.pos[i * 2 + 1] + (this.dragPointer[1] - this.pos[i * 2 + 1]) * a;
      this.vel[i * 2] = (nx - this.pos[i * 2]) / h;
      this.vel[i * 2 + 1] = (ny - this.pos[i * 2 + 1]) / h;
      this.pos[i * 2] = nx;
      this.pos[i * 2 + 1] = ny;
      // 膜：同层邻居按距离带偏
      const bx = this.pos[i * 2] - this.rest[i * 2] - this.blockOffset[this.blockOf[i] * 2];
      const by = this.pos[i * 2 + 1] - this.rest[i * 2 + 1] - this.blockOffset[this.blockOf[i] * 2 + 1];
      const block = this.blockOf[i];
      const cols = this.blockCols[block];
      const srcC = this.localOf[i] % cols;
      const srcR = Math.floor(this.localOf[i] / cols);
      for (let j = 0; j < n; j++) {
        if (j === i || this.blockOf[j] !== block) continue;
        const jc = this.localOf[j] % cols;
        const jr = Math.floor(this.localOf[j] / cols);
        const d2 = (jc - srcC) * (jc - srcC) + (jr - srcR) * (jr - srcR);
        const g = Math.exp(-d2 / (2 * MEMBRANE_SIGMA * MEMBRANE_SIGMA)) * MEMBRANE_GAIN;
        this.membrane[j * 2] = bx * g;
        this.membrane[j * 2 + 1] = by * g;
      }
      this.membraneOn = true;
    }

    // 整层偏移：拖动时直接设置，松手后弹回 0
    for (let b = 0; b < this.blockOffset.length / 2; b++) {
      if (b === this.dragBlock) continue;
      const ox = this.blockOffset[b * 2];
      const oy = this.blockOffset[b * 2 + 1];
      if (ox === 0 && oy === 0 && this.blockVel[b * 2] === 0 && this.blockVel[b * 2 + 1] === 0) continue;
      let vx = this.blockVel[b * 2];
      let vy = this.blockVel[b * 2 + 1];
      vx += (-90 * ox - 11 * vx) * h;
      vy += (-90 * oy - 11 * vy) * h;
      this.blockOffset[b * 2] = ox + vx * h;
      this.blockOffset[b * 2 + 1] = oy + vy * h;
      this.blockVel[b * 2] = vx;
      this.blockVel[b * 2 + 1] = vy;
    }

    for (let i = 0; i < n; i++) {
      const i2 = i * 2;
      const b = this.blockOf[i];
      let targetX = this.rest[i2] + this.blockOffset[b * 2];
      let targetY = this.rest[i2 + 1] + this.blockOffset[b * 2 + 1];
      if (this.membraneOn && i !== this.dragIdx) {
        targetX += this.membrane[i2];
        targetY += this.membrane[i2 + 1];
      }
      if (i === this.dragIdx) {
        // 被拖节点不做弹簧回位
      } else {
        let vx = this.vel[i2];
        let vy = this.vel[i2 + 1];
        const ax = K_NODE * (targetX - this.pos[i2]) - D_NODE * vx;
        const ay = K_NODE * (targetY - this.pos[i2 + 1]) - D_NODE * vy;
        vx += ax * h;
        vy += ay * h;
        this.pos[i2] += vx * h;
        this.pos[i2 + 1] += vy * h;
        this.vel[i2] = vx;
        this.vel[i2 + 1] = vy;
        // 液体倾斜：由加速度决定（像容器里的水）
        const tiltTarget = Math.max(-0.7, Math.min(0.7, Math.atan2(ax, 2400)));
        this.tilt[i] += (tiltTarget - this.tilt[i]) * (1 - Math.exp(-11 * h));
      }
      // 液面弹簧
      let lv = this.levelVel[i];
      lv += (K_LEVEL * (this.levelTarget[i] - this.level[i]) - D_LEVEL * lv) * h;
      this.level[i] = Math.max(0, Math.min(1.15, this.level[i] + lv * h));
      this.levelVel[i] = lv;
      // 晃荡衰减
      this.slosh[i] *= Math.exp(-2.3 * h);
      this.sloshPhase[i] += h * (7 + this.slosh[i] * 26);
      this.flash[i] *= Math.exp(-4.2 * h);
      if (
        Math.abs(this.levelTarget[i] - this.level[i]) > 0.004 ||
        Math.abs(this.levelVel[i]) > 0.02 ||
        this.slosh[i] > 0.02 ||
        this.flash[i] > 0.02 ||
        Math.abs(this.vel[i2]) > 0.4 ||
        Math.abs(this.vel[i2 + 1]) > 0.4
      ) {
        moved = true;
      }
    }
    return moved;
  }

  /** 是否仍在运动 */
  moving(): boolean {
    if (this.dragIdx >= 0 || this.dragBlock >= 0 || this.membraneOn) return true;
    for (let i = 0; i < NODE_TOTAL; i++) {
      const i2 = i * 2;
      if (Math.abs(this.vel[i2]) > 0.6 || Math.abs(this.vel[i2 + 1]) > 0.6) return true;
      if (Math.abs(this.levelTarget[i] - this.level[i]) > 0.004) return true;
      if (this.slosh[i] > 0.02 || this.flash[i] > 0.02) return true;
    }
    return false;
  }
}

/* ------------------------------------------------------------------ */
/*  绘制                                                              */
/* ------------------------------------------------------------------ */

/**
 * 画一个"玻璃球 + 液体"节点（参考视觉：深海军蓝玻璃球、亮绿液体、左上高光）。
 * 液面：过圆心的直线按倾角旋转，再叠加一段行进波（两端贴住圆周）。
 */
export function drawLiquidNode(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  level: number,
  tilt: number,
  slosh: number,
  phase: number,
  rgb: string,
  rimAlpha = 0.22,
) {
  const TAU = Math.PI * 2;
  // ---- 玻璃球体（左上偏亮，右下更深） ----
  const body = ctx.createRadialGradient(cx - r * 0.34, cy - r * 0.4, r * 0.08, cx, cy, r * 1.12);
  body.addColorStop(0, PAL.glassHi);
  body.addColorStop(0.5, PAL.glassMid);
  body.addColorStop(1, PAL.glassLo);
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, TAU);
  ctx.fillStyle = body;
  ctx.fill();

  const sinT = Math.sin(tilt);
  const cosT = Math.cos(tilt);
  const nx = sinT;
  const ny = cosT;
  const s = r - 2 * r * Math.min(1, level);

  if (level > 0.008) {
    // ---- 液体（裁剪在球内） ----
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.995, 0, TAU);
    ctx.clip();
    const lit = Math.max(0, -ny);
    const lg = ctx.createLinearGradient(
      cx + nx * s + ny * r,
      cy + ny * s - nx * r,
      cx + nx * s - ny * r,
      cy + ny * s + nx * r,
    );
    lg.addColorStop(0, `rgba(${rgb}, 0.62)`);
    lg.addColorStop(0.45, `rgba(${rgb}, 0.92)`);
    lg.addColorStop(1, `rgba(${rgb}, 0.70)`);

    const SEG = 9;
    const amp = Math.min(0.2, 0.045 + slosh * 0.16) * r;
    if (s <= -r + 0.01) {
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.99, 0, TAU);
      ctx.fillStyle = lg;
      ctx.fill();
    } else {
      const h = Math.sqrt(Math.max(0, r * r - s * s));
      const tx = -ny;
      const ty = nx;
      let p1x = cx + nx * s + tx * h;
      let p1y = cy + ny * s + ty * h;
      let p2x = cx + nx * s - tx * h;
      let p2y = cy + ny * s - ty * h;
      let a1 = Math.atan2(p1y - cy, p1x - cx);
      let a2 = Math.atan2(p2y - cy, p2x - cx);
      const nAng = Math.atan2(ny, nx);
      const norm = (a: number) => ((a % TAU) + TAU) % TAU;
      if (norm(nAng - a1) > norm(a2 - a1)) {
        const t1 = a1;
        a1 = a2;
        a2 = t1;
        const t2 = p1x;
        p1x = p2x;
        p2x = t2;
        const t3 = p1y;
        p1y = p2y;
        p2y = t3;
      }
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.99, a1, a2, false);
      for (let i = 1; i <= SEG; i++) {
        const u = i / SEG;
        const wx0 = p2x + (p1x - p2x) * u;
        const wy0 = p2y + (p1y - p2y) * u;
        const w = amp * Math.sin(u * 5.2 + phase) * Math.sin(Math.PI * u);
        ctx.lineTo(wx0 + nx * w, wy0 + ny * w);
      }
      ctx.closePath();
      ctx.fillStyle = lg;
      ctx.fill();
      // 液面亮边
      ctx.beginPath();
      for (let i = 0; i <= SEG; i++) {
        const u = i / SEG;
        const wx0 = p2x + (p1x - p2x) * u;
        const wy0 = p2y + (p1y - p2y) * u;
        const w = amp * Math.sin(u * 5.2 + phase) * Math.sin(Math.PI * u);
        if (i === 0) ctx.moveTo(wx0 + nx * w, wy0 + ny * w);
        else ctx.lineTo(wx0 + nx * w, wy0 + ny * w);
      }
      ctx.strokeStyle = 'rgba(226, 255, 236, 0.72)';
      ctx.lineWidth = Math.max(0.8, r * 0.045);
      ctx.stroke();
    }
    // 球内的下部阴影（让液体看起来有厚度）
    const shade = ctx.createLinearGradient(cx, cy - r * 0.2, cx, cy + r);
    shade.addColorStop(0, 'rgba(4, 12, 22, 0)');
    shade.addColorStop(1, 'rgba(4, 12, 22, 0.35)');
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.99, 0, TAU);
    ctx.fillStyle = shade;
    ctx.fill();
    ctx.restore();
    void lit;
  }

  // ---- 玻璃边缘：外环 + 左上高光弧 ----
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, TAU);
  ctx.strokeStyle = `rgba(${PAL.rim}, ${Math.max(0.08, rimAlpha * 0.55)})`;
  ctx.lineWidth = Math.max(0.8, r * 0.03);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.955, Math.PI * 1.08, Math.PI * 1.68);
  ctx.strokeStyle = 'rgba(224, 246, 252, 0.32)';
  ctx.lineWidth = Math.max(1, r * 0.05);
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.lineCap = 'butt';

  // ---- 顶部镜面高光 ----
  ctx.beginPath();
  ctx.ellipse(cx - r * 0.34, cy - r * 0.5, r * 0.24, r * 0.13, -0.5, 0, TAU);
  ctx.fillStyle = 'rgba(232, 250, 255, 0.20)';
  ctx.fill();
}
