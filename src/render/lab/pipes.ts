/**
 * 管道系统 —— 粗"水管"连接层与层，能量在管内流动，到节点处注入。
 *
 * 渲染分层（从下往上）：
 *   外壳（深色描边）→ 管腔（暗底）→ 管内流体（虚线流动，亮度 = 真实能量）→ 高能辉光
 * 管道起点在输入层的"汇流排"（输入格背面），不遮挡输入像素。
 *
 * 物理：鼠标扫过时管道被拨弯（控制点偏移 + 阻尼振荡），松手回正。
 */

import type { PipeSpec, SchematicPlan } from './schematic';
import { SLOT_COUNT, type LabLayout } from './geometry';
import { PAL } from './palette';

interface PipeGeom {
  ax: number;
  ay: number;
  cx: number;
  cy: number;
  bx: number;
  by: number;
  len: number;
  /** 静态弯曲偏移（让同层管道散开，不重叠） */
  bendX: number;
  bendY: number;
}

export class PipeSystem {
  plan: SchematicPlan | null = null;
  private geom: PipeGeom[] = [];
  /** 拨动状态 */
  private off: Float32Array = new Float32Array(0);
  private vel: Float32Array = new Float32Array(0);
  private active: number[] = [];
  flowPhase = 0;
  drawnPipes = 0;

  constructor(private layout: LabLayout) {}

  setPlan(plan: SchematicPlan) {
    this.plan = plan;
    const n = plan.pipes.length;
    if (this.off.length !== n) {
      this.off = new Float32Array(n);
      this.vel = new Float32Array(n);
    }
    this.geom = plan.pipes.map((p, i) => this.makeGeom(p, i));
  }

  get pipes(): PipeSpec[] {
    return this.plan?.pipes ?? [];
  }

  get plucking(): number {
    return this.active.length;
  }

  /** 计算一条管道的静态几何（起终点贴在圆边/汇流排上） */
  private makeGeom(p: PipeSpec, idx: number): PipeGeom {
    const L = this.layout;
    const toBlock = L.blocks[p.toLayer];
    const toGi = toBlock.firstNode + p.toSlot;
    const bx = this.nodeX(toGi);
    const by = this.nodeY(toGi);
    const rB = toBlock.radius;

    let ax: number;
    let ay: number;
    if (p.fromLayer === 0) {
      // 汇流排上按槽位分布
      const n = SLOT_COUNT.l1;
      const spread = Math.min(L.manifoldH * 0.9, (n - 1) * 46);
      ay = (p.toSlot - (n - 1) / 2) * (spread / Math.max(1, n - 1));
      ax = L.manifoldX;
    } else {
      const fromBlock = L.blocks[p.fromLayer];
      const fromGi = fromBlock.firstNode + p.fromSlot;
      ax = this.nodeX(fromGi);
      ay = this.nodeY(fromGi);
    }

    // 控制点：先水平离开，再弯向目标（管子从"背面"接出来的观感）
    const bend = p.fromLayer === 0 ? 0.55 : 0.42;
    let cx = ax + (bx - ax) * bend;
    let cy = ay + (by - ay) * 0.12;
    // 同层散开：按序号给一点垂直偏移
    const spreadSign = idx % 2 === 0 ? 1 : -1;
    const extra = p.fromLayer === 0 ? 0 : spreadSign * 26;
    cy += extra;

    // 端点缩到圆边
    const dirBX = cx - bx;
    const dirBY = cy - by;
    const dl = Math.hypot(dirBX, dirBY) || 1;
    const bx2 = bx + (dirBX / dl) * (rB + 8);
    const by2 = by + (dirBY / dl) * (rB + 8);
    const dirAX = cx - ax;
    const dirAY = cy - ay;
    const al = Math.hypot(dirAX, dirAY) || 1;
    const ax2 = ax + (dirAX / al) * (p.fromLayer === 0 ? 16 : L.blocks[p.fromLayer].radius + 6);
    const ay2 = ay + (dirAY / al) * (p.fromLayer === 0 ? 0 : L.blocks[p.fromLayer].radius + 6);

    const len = Math.hypot(bx2 - ax2, by2 - ay2) * 1.12;
    return { ax: ax2, ay: ay2, cx, cy, bx: bx2, by: by2, len, bendX: 0, bendY: 0 };
  }

  private nodeX = (gi: number) => this.nodes.pos[gi * 2];
  private nodeY = (gi: number) => this.nodes.pos[gi * 2 + 1];

  /** 由场景注入（读取节点当前位置） */
  nodes!: { pos: Float32Array };

  /** 节点移动后重建几何 */
  rebuild() {
    if (!this.plan) return;
    this.geom = this.plan.pipes.map((p, i) => this.makeGeom(p, i));
  }

  /** 沿管道取点（粒子用）：t ∈ [0,1] */
  pointAt(i: number, t: number): [number, number, number, number] {
    const g = this.geom[i];
    if (!g) return [0, 0, 0, 0];
    const off = this.off[i] ?? 0;
    // 控制点带拨动偏移（垂直于管道方向）
    const nx = -(g.by - g.ay) / (g.len || 1);
    const ny = (g.bx - g.ax) / (g.len || 1);
    const cx = g.cx + nx * off;
    const cy = g.cy + ny * off;
    const u = 1 - t;
    const x = u * u * g.ax + 2 * u * t * cx + t * t * g.bx;
    const y = u * u * g.ay + 2 * u * t * cy + t * t * g.by;
    const dx = 2 * u * (cx - g.ax) + 2 * t * (g.bx - cx);
    const dy = 2 * u * (cy - g.ay) + 2 * t * (g.by - cy);
    return [x, y, dx, dy];
  }

  /** 鼠标扫过：拨弯管道 */
  pluck(wx: number, wy: number, vx: number, vy: number, radius: number) {
    const speed = Math.hypot(vx, vy);
    const impulse = Math.min(1.4, 0.25 + speed * 0.01);
    for (let i = 0; i < this.geom.length; i++) {
      const g = this.geom[i];
      const p = this.pointAt(i, 0.5);
      const d = Math.hypot(wx - p[0], wy - p[1]);
      if (d > radius + (this.pipes[i]?.width ?? 10)) continue;
      const falloff = Math.max(0, 1 - d / (radius + 30));
      const nx = -(g.by - g.ay) / (g.len || 1);
      const ny = (g.bx - g.ax) / (g.len || 1);
      const vperp = vx * nx + vy * ny;
      const push = Math.min(g.len * 0.18, Math.abs(vperp) * 0.05 + 3) * impulse * falloff;
      const sign = vperp >= 0 ? 1 : -1;
      this.off[i] += sign * push;
      this.vel[i] += sign * push * 7;
      if (!this.active.includes(i)) this.active.push(i);
    }
  }

  /** 清掉所有拨动（复位舞台时用） */
  clearPluck() {
    this.off.fill(0);
    this.vel.fill(0);
    this.active.length = 0;
  }

  step(dt: number) {
    if (this.active.length === 0) return;
    const h = Math.min(dt, 1 / 30);
    for (let k = 0; k < this.active.length; k++) {
      const i = this.active[k];
      let o = this.off[i];
      let v = this.vel[i];
      v += (-170 * o - 9 * v) * h;
      o += v * h;
      if (Math.abs(o) < 0.2 && Math.abs(v) < 0.8) {
        this.off[i] = 0;
        this.vel[i] = 0;
        this.active.splice(k, 1);
        k--;
        continue;
      }
      this.off[i] = o;
      this.vel[i] = v;
    }
    this.flowPhase += dt * 46;
  }

  /** 绘制所有管道（在输入层之前绘制 → 从背面接出，不遮挡像素格） */
  draw(ctx: CanvasRenderingContext2D, k: number, brightness: number) {
    if (!this.plan) return;
    this.drawnPipes = 0;
    ctx.lineCap = 'round';
    for (let i = 0; i < this.geom.length; i++) {
      const p = this.plan.pipes[i];
      const g = this.geom[i];
      if (!g) continue;
      const off = this.off[i] ?? 0;
      const nx = -(g.by - g.ay) / (g.len || 1);
      const ny = (g.bx - g.ax) / (g.len || 1);
      const cx = g.cx + nx * off;
      const cy = g.cy + ny * off;
      const path = new Path2D();
      path.moveTo(g.ax, g.ay);
      path.quadraticCurveTo(cx, cy, g.bx, g.by);

      const w = p.width;
      const e = Math.min(1, Math.max(0, p.energy));
      const active = e > 0.001;
      const core = p.toLayer === 4 ? PAL.pipeCoreOut : PAL.pipeCore;

      if (!active) {
        // 空管（贡献不显著）：只有暗外壳 + 暗腔，一眼看出"这根没在传能量"
        ctx.strokeStyle = PAL.pipeDeadCasing;
        ctx.lineWidth = w + 6;
        ctx.stroke(path);
        ctx.strokeStyle = PAL.pipeDeadBore;
        ctx.lineWidth = w;
        ctx.stroke(path);
        this.drawnPipes++;
        continue;
      }

      // 高能管道的外发光（超线性 → 强弱一眼可辨）
      ctx.strokeStyle = `rgba(${core}, ${((0.02 + 0.26 * Math.pow(e, 1.8)) * brightness).toFixed(3)})`;
      ctx.lineWidth = w + 30;
      ctx.stroke(path);
      // 外壳
      ctx.strokeStyle = PAL.pipeCasing;
      ctx.lineWidth = w + 8;
      ctx.stroke(path);
      // 管壁细高光
      ctx.strokeStyle = PAL.pipeEdge;
      ctx.lineWidth = w + 8;
      ctx.stroke(path);
      // 管腔
      ctx.strokeStyle = PAL.pipeBore;
      ctx.lineWidth = w;
      ctx.stroke(path);
      // 流体核心：幂曲线，低能量管道几乎不亮
      ctx.strokeStyle = `rgba(${core}, ${((0.05 + 0.88 * Math.pow(e, 1.6)) * brightness).toFixed(3)})`;
      ctx.lineWidth = w * 0.52;
      ctx.stroke(path);

      // 管内流动箭头（参考视觉的关键元素）
      {
        const segs = Math.max(2, Math.round(g.len / 52));
        const chev = Math.min(w * 0.3, 9);
        const step = this.flowPhase * 0.055 * (0.7 + e);
        ctx.strokeStyle = `rgba(222, 255, 232, ${((0.05 + 0.92 * Math.pow(e, 1.5)) * brightness).toFixed(3)})`;
        ctx.lineWidth = Math.max(1.2, w * 0.16);
        ctx.beginPath();
        for (let sIdx = 0; sIdx < segs; sIdx++) {
          const t = (sIdx / segs + step) % 1;
          const [x, y, dx, dy] = this.pointAt(i, t);
          const dl = Math.hypot(dx, dy) || 1;
          const ux = dx / dl;
          const uy = dy / dl;
          const px = -uy;
          const py = ux;
          ctx.moveTo(x - ux * chev + px * chev, y - uy * chev + py * chev);
          ctx.lineTo(x + ux * chev * 0.35, y + uy * chev * 0.35);
          ctx.lineTo(x - ux * chev - px * chev, y - uy * chev - py * chev);
        }
        ctx.stroke();
      }
      this.drawnPipes++;
    }
    void k;
  }
}
