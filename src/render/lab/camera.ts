/**
 * 相机：平移 / 以光标为锚点缩放 / 程序化飞行。
 * 手势 1:1 跟手；程序化移动走三次缓动（可被 reduced-motion 直接跳到终点）。
 */

import { Spring, SPRING } from '../../motion/spring';

export interface CameraTarget {
  cx: number;
  cy: number;
  k: number;
}

export class LabCamera {
  x = 0;
  y = 0;
  k = 1;
  minK = 0.08;
  maxK = 8;
  private viewW = 1200;
  private viewH = 800;
  private kSpring = new Spring(1, SPRING.camera);
  private zoomAnchor: { sx: number; sy: number; wx: number; wy: number } | null = null;
  private fly: { fx: number; fy: number; fk: number; tx: number; ty: number; tk: number; t: number; dur: number } | null =
    null;
  private inertia = { vx: 0, vy: 0 };
  private lastPan = 0;

  setViewport(w: number, h: number) {
    this.viewW = w;
    this.viewH = h;
  }

  get viewport(): [number, number] {
    return [this.viewW, this.viewH];
  }

  snap(t: CameraTarget) {
    this.x = t.cx;
    this.y = t.cy;
    this.k = t.k;
    this.kSpring.snap(t.k);
    this.zoomAnchor = null;
    this.fly = null;
    this.inertia.vx = 0;
    this.inertia.vy = 0;
  }

  flyTo(t: CameraTarget, dur = 0.9) {
    this.fly = { fx: this.x, fy: this.y, fk: this.k, tx: t.cx, ty: t.cy, tk: t.k, t: 0, dur };
    this.zoomAnchor = null;
    // 关键：弹簧目标必须同步到飞行终点。
    // 否则飞行结束后弹簧仍指向旧目标，下一次捏合/缩放会被它往回拽（表现为缩放"跳一下"）。
    this.kSpring.snap(t.k);
  }

  get flying() {
    return this.fly !== null;
  }

  step(dt: number, reduced: boolean): boolean {
    if (this.fly) {
      if (reduced) {
        this.snap({ cx: this.fly.tx, cy: this.fly.ty, k: this.fly.tk });
        return true;
      }
      this.fly.t += dt;
      const p = Math.min(1, this.fly.t / this.fly.dur);
      const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
      this.x = this.fly.fx + (this.fly.tx - this.fly.fx) * e;
      this.y = this.fly.fy + (this.fly.ty - this.fly.fy) * e;
      this.k = this.fly.fk + (this.fly.tk - this.fly.fk) * e;
      if (p >= 1) this.fly = null;
      return true;
    }
    let moving = this.kSpring.step(dt);
    if (this.zoomAnchor) {
      const { sx, sy, wx, wy } = this.zoomAnchor;
      this.k = this.kSpring.value;
      this.x = wx - (sx - this.viewW / 2) / this.k;
      this.y = wy - (sy - this.viewH / 2) / this.k;
      if (this.kSpring.isSettled) this.zoomAnchor = null;
      moving = true;
    }
    if (!reduced && (this.inertia.vx !== 0 || this.inertia.vy !== 0)) {
      this.x -= this.inertia.vx * dt;
      this.y -= this.inertia.vy * dt;
      const decay = Math.exp(-4.0 * dt);
      this.inertia.vx *= decay;
      this.inertia.vy *= decay;
      if (Math.abs(this.inertia.vx) < 2 && Math.abs(this.inertia.vy) < 2) this.inertia.vx = this.inertia.vy = 0;
      moving = true;
    }
    return moving;
  }

  /**
   * 平移。`momentum = false` 用于滚轮/触控板：直接位移、不加惯性
   * （滚轮事件密集，惯性项会按 dt 放大成十几倍，把画面甩飞）。
   */
  panBy(dxScreen: number, dyScreen: number, now: number, momentum = true) {
    this.x -= dxScreen / this.k;
    this.y -= dyScreen / this.k;
    if (momentum) {
      const dt = Math.max(1e-3, (now - this.lastPan) / 1000);
      const vx = dxScreen / this.k / dt;
      const vy = dyScreen / this.k / dt;
      const cap = 4000; // 速度上限，防止一次大位移变成"发射"
      this.inertia.vx = Math.max(-cap, Math.min(cap, vx));
      this.inertia.vy = Math.max(-cap, Math.min(cap, vy));
    } else {
      this.inertia.vx = 0;
      this.inertia.vy = 0;
    }
    this.lastPan = now;
    this.fly = null;
  }

  endPan(reduced: boolean) {
    if (reduced) this.inertia.vx = this.inertia.vy = 0;
  }

  zoomAt(sx: number, sy: number, factor: number, reduced: boolean) {
    // 以"弹簧当前目标"为基准累乘：连续快速捏合/滚轮才能叠加，
    // 否则每次都以滞后的 k 计算，缩放会被吃掉大半。
    const base = this.zoomAnchor ? this.kSpring.goal : this.k;
    const newK = Math.min(this.maxK, Math.max(this.minK, base * factor));
    const wx = this.x + (sx - this.viewW / 2) / this.k;
    const wy = this.y + (sy - this.viewH / 2) / this.k;
    if (reduced) {
      this.k = newK;
      this.kSpring.snap(newK);
      this.x = wx - (sx - this.viewW / 2) / newK;
      this.y = wy - (sy - this.viewH / 2) / newK;
      this.zoomAnchor = null;
      return;
    }
    this.kSpring.setTarget(newK);
    this.zoomAnchor = { sx, sy, wx, wy };
  }

  /**
   * 双指手势（缩放 + 平移一体，1:1 跟手）。
   * 关键：把"上一帧中点下的世界点"移动到"这一帧的中点"，同时应用缩放比例 ——
   * 不用 zoomAnchor（它每帧会按锚点重算 x/y，会把同一手势里的平移吃掉）。
   */
  pinchTo(sx: number, sy: number, prevSx: number, prevSy: number, factor: number) {
    const k0 = this.k;
    const newK = Math.min(this.maxK, Math.max(this.minK, k0 * factor));
    const wx = this.x + (prevSx - this.viewW / 2) / k0;
    const wy = this.y + (prevSy - this.viewH / 2) / k0;
    this.k = newK;
    this.kSpring.snap(newK);
    this.zoomAnchor = null;
    this.fly = null;
    this.inertia.vx = 0;
    this.inertia.vy = 0;
    this.x = wx - (sx - this.viewW / 2) / newK;
    this.y = wy - (sy - this.viewH / 2) / newK;
  }

  toScreen(wx: number, wy: number): [number, number] {
    return [this.viewW / 2 + (wx - this.x) * this.k, this.viewH / 2 + (wy - this.y) * this.k];
  }

  toWorld(sx: number, sy: number): [number, number] {
    return [this.x + (sx - this.viewW / 2) / this.k, this.y + (sy - this.viewH / 2) / this.k];
  }

  fit(totalW: number, totalH: number, margin = 70, reduced = false) {
    const k = Math.min((this.viewW - margin * 2) / totalW, (this.viewH - margin * 2) / totalH);
    const target = { cx: totalW / 2, cy: 0, k: Math.max(0.05, Math.min(k, 2)) };
    this.minK = Math.max(0.04, target.k * 0.55);
    if (reduced) this.snap(target);
    else this.flyTo(target, 0.8);
  }
}
