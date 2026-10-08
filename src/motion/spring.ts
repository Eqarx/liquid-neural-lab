/**
 * 弹簧物理 —— 帧率无关的临界阻尼/欠阻尼弹簧（半隐式欧拉）。
 *
 * 遵循 motion-web 手感规则：
 *  - 一切"跟随"（相机、数值平滑）都走弹簧/指数滤波，而不是线性插值；
 *  - dt 钳制 + 速度保持，中断后可平滑改向（可中断性）；
 *  - 收敛判定带速度阈值，动画完成后可以休眠（60fps 预算）。
 */

export interface SpringConfig {
  /** 刚度：越大响应越快 */
  stiffness: number;
  /** 阻尼：越大越稳（无回弹） */
  damping: number;
}

export const SPRING = {
  /** 数值/条形图平滑：轻微欠阻尼，有一点点"落定"感 */
  data: { stiffness: 260, damping: 26 },
  /** 快速 UI 数值：几乎临界阻尼 */
  snappy: { stiffness: 400, damping: 34 },
  /** 相机跟随：平滑无过冲 */
  camera: { stiffness: 90, damping: 18 },
  /** 节点回位：柔和 */
  node: { stiffness: 120, damping: 20 },
} as const;

const EPS = 1e-4;

export class Spring {
  value: number;
  velocity = 0;
  private target: number;
  private cfg: SpringConfig;
  private settled = true;

  constructor(initial: number, cfg: SpringConfig = SPRING.data) {
    this.value = initial;
    this.target = initial;
    this.cfg = cfg;
  }

  get isSettled() {
    return this.settled;
  }

  /** 当前目标值（相机缩放累乘需要以它为准，而不是滞后的 value） */
  get goal() {
    return this.target;
  }

  /** 设置目标；若弹簧已静止则直接跳变（省掉首帧动画成本） */
  setTarget(t: number, jumpIfIdle = false) {
    if (jumpIfIdle && this.settled) {
      this.value = t;
      this.target = t;
      this.velocity = 0;
      return;
    }
    if (t !== this.target) {
      this.target = t;
      this.settled = false;
    }
  }

  setConfig(cfg: SpringConfig) {
    this.cfg = cfg;
  }

  /** 硬跳变（reduced-motion 或重置场景） */
  snap(t: number) {
    this.value = t;
    this.target = t;
    this.velocity = 0;
    this.settled = true;
  }

  /** 步进。dt 秒。返回是否仍在运动。 */
  step(dt: number): boolean {
    if (this.settled) return false;
    const { stiffness, damping } = this.cfg;
    // dt 钳制：后台标签页恢复时不会出现大步长爆炸
    const h = Math.min(dt, 1 / 30);
    const accel = stiffness * (this.target - this.value) - damping * this.velocity;
    this.velocity += accel * h;
    this.value += this.velocity * h;
    if (Math.abs(this.target - this.value) < EPS && Math.abs(this.velocity) < EPS * 10) {
      this.value = this.target;
      this.velocity = 0;
      this.settled = true;
    }
    return !this.settled;
  }
}

/** 指数平滑跟随（帧率无关）：v += (target - v) * (1 - exp(-k*dt))，带速度/k 前导项 */
export class FollowFilter {
  value: number;
  private k: number;
  private settled = true;
  private target: number;

  constructor(initial: number, k = 10) {
    this.value = initial;
    this.target = initial;
    this.k = k;
  }

  setTarget(t: number) {
    if (t !== this.target) {
      this.target = t;
      this.settled = false;
    }
  }

  step(dt: number): boolean {
    if (this.settled) return false;
    const h = Math.min(dt, 1 / 30);
    const a = 1 - Math.exp(-this.k * h);
    this.value += (this.target - this.value) * a;
    if (Math.abs(this.target - this.value) < EPS) {
      this.value = this.target;
      this.settled = true;
    }
    return !this.settled;
  }
}

/** 缓动字典（animate / emil-design-eng 的强自定义曲线） */
export const EASE = {
  /** 入场/出场：强 ease-out */
  out: 'cubic-bezier(0.23, 1, 0.32, 1)',
  /** 屏幕内移动/形变：强 ease-in-out */
  inOut: 'cubic-bezier(0.77, 0, 0.175, 1)',
  /** 抽屉/面板：iOS 风格 */
  drawer: 'cubic-bezier(0.32, 0.72, 0, 1)',
} as const;

export const DUR = {
  press: 160,
  tooltip: 180,
  popover: 200,
  panel: 280,
  modal: 320,
} as const;
