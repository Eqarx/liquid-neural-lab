/**
 * 能量流 —— 在管道里流动的光团，到节点处注入（液面上升 + 闪光）。
 *
 * 与旧版的区别：粒子不再沿"边"飞，而是沿"管道"（贝塞尔）走，t 从 0 到 1。
 * 管道粗、数量少，能量注入因此看得非常清楚。
 */

import { glowSprite } from './palette';
import type { PipeSystem } from './pipes';

export interface FlowHost {
  /** 光团到达节点（层号 1..4、槽位、是否注入波） */
  onArrive(layer: number, slot: number, isWave: boolean): void;
}

const SPRITE_WARM = '150, 250, 180';
const SPRITE_WAVE = '222, 255, 232';

export class FlowSystem {
  private cap: number;
  private pipe: Int32Array;
  private t: Float32Array;
  private speed: Float32Array;
  private size: Float32Array;
  private hot: Uint8Array;
  private alive: Uint8Array;
  private stack: Int32Array;
  private stackTop = 0;
  private acc = 0;
  count = 0;

  constructor(cap = 700) {
    this.cap = cap;
    this.pipe = new Int32Array(cap);
    this.t = new Float32Array(cap);
    this.speed = new Float32Array(cap);
    this.size = new Float32Array(cap);
    this.hot = new Uint8Array(cap);
    this.alive = new Uint8Array(cap);
    this.stack = new Int32Array(cap);
    for (let i = 0; i < cap; i++) this.stack[i] = cap - 1 - i;
    this.stackTop = cap;
  }

  clear() {
    this.alive.fill(0);
    this.count = 0;
    this.stackTop = this.cap;
    for (let i = 0; i < this.cap; i++) this.stack[i] = this.cap - 1 - i;
  }

  private alloc(): number {
    if (this.stackTop <= 0) return -1;
    const i = this.stack[--this.stackTop];
    this.alive[i] = 1;
    this.count++;
    return i;
  }

  /** 在某根管道上发射光团 */
  spawn(pipes: PipeSystem, pipeIdx: number, isWave: boolean, at = 0): number {
    const i = this.alloc();
    if (i < 0) return -1;
    this.pipe[i] = pipeIdx;
    this.t[i] = at;
    const spec = pipes.pipes[pipeIdx];
    const speed = (isWave ? 1.15 : 0.62) * (0.85 + spec.energy * 0.5) * (0.9 + Math.random() * 0.25);
    this.speed[i] = speed;
    this.hot[i] = isWave ? 1 : 0;
    this.size[i] = isWave ? 12 : 7 + Math.random() * 4;
    return i;
  }

  /** 环境流：按管道能量加权发射 */
  ambient(dt: number, rate: number, pipes: PipeSystem) {
    if (rate <= 0 || pipes.pipes.length === 0) return;
    this.acc += dt * rate;
    let budget = Math.min(24, Math.floor(this.acc));
    if (budget <= 0) return;
    this.acc -= budget;
    while (budget-- > 0) {
      if (this.count >= this.cap - 20) return;
      // 只在"点亮的管道"上发射，按能量平方加权（空管不发光团）
      let total = 0;
      for (const p of pipes.pipes) if (p.energy > 0) total += p.energy * p.energy + 0.05;
      if (total <= 0) return;
      let r = Math.random() * total;
      let idx = -1;
      for (let i = 0; i < pipes.pipes.length; i++) {
        const p = pipes.pipes[i];
        if (p.energy <= 0) continue;
        r -= p.energy * p.energy + 0.05;
        if (r <= 0) {
          idx = i;
          break;
        }
      }
      if (idx < 0) return;
      this.spawn(pipes, idx, false);
    }
  }

  /** 注入波：某一层"点亮的管道"同时喷发（若该层全暗，用最强的一根） */
  wave(pipes: PipeSystem, layer: number, perPipe: number) {
    const list = pipes.pipes;
    let best = -1;
    let bestE = 0;
    for (let i = 0; i < list.length; i++) {
      if (list[i].toLayer !== layer) continue;
      if (list[i].energy > bestE) {
        bestE = list[i].energy;
        best = i;
      }
      if (list[i].energy <= 0) continue;
      for (let k = 0; k < perPipe; k++) {
        const idx = this.spawn(pipes, i, true, -k * 0.06);
        if (idx < 0) return;
      }
    }
    if (bestE <= 0 && best >= 0) {
      for (let k = 0; k < perPipe; k++) if (this.spawn(pipes, best, true, -k * 0.06) < 0) return;
    }
  }

  /**
   * 沿"真实热点路径"注入：通向目标节点的管道多发，
   * 其余点亮的管道只补一两颗 —— 这样动画的落点就是答案本身。
   */
  wavePath(pipes: PipeSystem, layer: number, targetSlot: number, perPipe: number) {
    const list = pipes.pipes;
    let main = 0;
    let fallback = -1;
    let fallbackE = 0;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (p.toLayer !== layer) continue;
      if (p.energy <= 0) continue;
      if (p.toSlot === targetSlot) {
        for (let k = 0; k < perPipe; k++) {
          if (this.spawn(pipes, i, true, -k * 0.05) < 0) return;
          main++;
        }
      } else {
        // 旁支：少量光团，保持"整层都在动"的观感
        if (p.energy > fallbackE) {
          fallbackE = p.energy;
          fallback = i;
        }
        if (Math.random() < 0.45) this.spawn(pipes, i, true, -Math.random() * 0.1);
      }
    }
    if (main === 0) {
      // 目标节点这一拍没有点亮的主管道：退化为该层最强管道，保证动画仍然发生
      if (fallback >= 0) {
        for (let k = 0; k < perPipe; k++) if (this.spawn(pipes, fallback, true, -k * 0.05) < 0) return;
      } else {
        this.wave(pipes, layer, perPipe);
      }
    }
  }

  update(dt: number, pipes: PipeSystem, host: FlowHost) {
    for (let i = 0; i < this.cap; i++) {
      if (!this.alive[i]) continue;
      this.t[i] += this.speed[i] * dt;
      if (this.t[i] < 0) continue;
      if (this.t[i] >= 1) {
        const spec = pipes.pipes[this.pipe[i]];
        if (spec) host.onArrive(spec.toLayer, spec.toSlot, this.hot[i] === 1);
        this.alive[i] = 0;
        this.count--;
        this.stack[this.stackTop++] = i;
      }
    }
  }

  draw(ctx: CanvasRenderingContext2D, k: number, pipes: PipeSystem, brightness: number) {
    if (this.count === 0) return;
    const prevOp = ctx.globalCompositeOperation;
    ctx.globalCompositeOperation = 'lighter';
    const warm = glowSprite(SPRITE_WARM, 0.45);
    const wave = glowSprite(SPRITE_WAVE, 0.4);
    for (let i = 0; i < this.cap; i++) {
      if (!this.alive[i]) continue;
      const t = this.t[i];
      if (t < 0) continue;
      const [x, y] = pipes.pointAt(this.pipe[i], Math.min(1, t));
      const r = this.size[i];
      const img = this.hot[i] ? wave : warm;
      ctx.globalAlpha = Math.min(1, (this.hot[i] ? 0.95 : 0.7) * brightness);
      ctx.drawImage(img, x - r, y - r, r * 2, r * 2);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = prevOp;
    void k;
  }
}
