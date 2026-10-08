/**
 * 共享 rAF 帧循环：所有画布动画、回放时钟共用一个循环，
 * 空闲（无订阅者）时自动休眠 —— 60fps 预算的核心。
 */

type Tick = (dt: number, t: number) => void;

class FrameLoop {
  private ticks = new Set<Tick>();
  private rafId: number | null = null;
  private last = 0;
  private first = true;

  get active() {
    return this.ticks.size > 0;
  }

  start(cb: Tick) {
    this.ticks.add(cb);
    if (this.rafId === null) {
      this.last = performance.now();
      this.rafId = requestAnimationFrame(this.frame);
    }
  }

  stop(cb: Tick) {
    this.ticks.delete(cb);
    if (this.ticks.size === 0 && this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private frame = (now: number) => {
    this.rafId = requestAnimationFrame(this.frame);
    let dt = (now - this.last) / 1000;
    this.last = now;
    if (this.first) {
      // 首帧 dt 无意义
      this.first = false;
      dt = Math.min(dt, 1 / 60);
    }
    if (dt > 0.05) dt = 0.05; // 长帧钳制：切回标签页时平滑恢复
    for (const cb of [...this.ticks]) {
      try {
        cb(dt, now / 1000);
      } catch (e) {
        // 单个订阅者出错不应拖垮整个循环
        this.ticks.delete(cb);
        console.error('[FrameLoop] tick error', e);
      }
    }
  };
}

export const frameLoop = new FrameLoop();
