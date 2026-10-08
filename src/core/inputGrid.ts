/**
 * 输入像素格 —— 用户直接在上面手写，写下的像素就是模型输入。
 * 无裁剪、无居中：屏幕上的 196 个格子 = 网络的 196 个输入值（所见即所算）。
 */
import { quantizeU8, roundHalfEven } from './quant';

export const SIDE = 14;
export const CELLS = SIDE * SIDE;

export interface GridChange {
  changed: boolean;
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

export class InputGrid {
  values = new Float32Array(CELLS);
  /** 模型输入缓存（8-bit 量化，float32） */
  private inputCache = new Float32Array(CELLS);
  private dirty = true;

  clear(): boolean {
    let had = false;
    for (let i = 0; i < CELLS; i++) {
      if (this.values[i] !== 0) had = true;
      this.values[i] = 0;
    }
    this.dirty = true;
    return had;
  }

  /** 软笔刷：以 (x,y) 为圆心（格坐标，可为小数）落一枚笔迹 */
  stamp(x: number, y: number, radius: number, strength: number, erase: boolean): GridChange {
    const r0 = Math.max(0, Math.floor(y - radius));
    const r1 = Math.min(SIDE - 1, Math.ceil(y + radius));
    const c0 = Math.max(0, Math.floor(x - radius));
    const c1 = Math.min(SIDE - 1, Math.ceil(x + radius));
    let changed = false;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const d = Math.hypot(c + 0.5 - x, r + 0.5 - y);
        if (d > radius) continue;
        const falloff = Math.pow(1 - d / radius, 1.35);
        const i = r * SIDE + c;
        if (erase) {
          const nv = Math.max(0, this.values[i] - falloff * strength);
          if (nv !== this.values[i]) {
            this.values[i] = nv;
            changed = true;
          }
        } else {
          const nv = Math.min(1, this.values[i] + falloff * strength * 0.95);
          if (nv > this.values[i]) {
            this.values[i] = nv;
            changed = true;
          }
        }
      }
    }
    if (changed) this.dirty = true;
    return { changed, r0, c0, r1, c1 };
  }

  /** 沿线段连续落笔（保证快速拖动也不断线） */
  stroke(x0: number, y0: number, x1: number, y1: number, radius: number, strength: number, erase: boolean): boolean {
    const dist = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(1, Math.ceil(dist / (radius * 0.35)));
    let changed = false;
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const r = this.stamp(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, radius, strength, erase);
      changed = changed || r.changed;
    }
    return changed;
  }

  /** 载入 14×14 原始像素（0..255） */
  loadRaw14(raw: ArrayLike<number>) {
    for (let i = 0; i < CELLS; i++) this.values[i] = (raw[i] ?? 0) / 255;
    this.dirty = true;
  }

  /** 载入 28×28 原始像素（0..255）：2×2 均值下采样（整数域 + 半偶舍入），与训练端一致 */
  loadRaw28(raw: ArrayLike<number>) {
    for (let r = 0; r < SIDE; r++) {
      for (let c = 0; c < SIDE; c++) {
        const i = (r * 2) * 28 + c * 2;
        const s = raw[i] + raw[i + 1] + raw[i + 28] + raw[i + 29];
        this.values[r * SIDE + c] = roundHalfEven(s / 4) / 255;
      }
    }
    this.dirty = true;
  }

  /** 模型输入：8-bit 量化（与训练端 round(x*255)/255 一致） */
  modelInput(): Float32Array {
    if (!this.dirty) return this.inputCache;
    quantizeU8(this.values, this.inputCache);
    this.dirty = false;
    return this.inputCache;
  }

  /** 平均强度（用于环境粒子的密度） */
  activity(): number {
    let s = 0;
    for (let i = 0; i < CELLS; i++) s += this.values[i];
    return s / CELLS;
  }

  inkCount(threshold = 0.08): number {
    let n = 0;
    for (let i = 0; i < CELLS; i++) if (this.values[i] > threshold) n++;
    return n;
  }
}
