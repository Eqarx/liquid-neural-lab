/** 配色与光晕精灵 —— 深海军蓝底 + 玻璃球 + 绿色能量（参考"液光管道"风格） */

export const PAL = {
  bg: '#071120',
  bgGlow: 'rgba(20, 62, 82, 0.5)',
  plate: 'rgba(12, 28, 45, 0.55)',
  plateLine: 'rgba(120, 190, 220, 0.13)',
  ink: '196, 255, 220',
  inkDim: '150, 180, 200',
  /** 答案 / 输出层强调 */
  pos: '190, 255, 190',
  /** 负权重（保留语义，收敛为冷青） */
  neg: '110, 190, 220',
  /** 能量光团 */
  signal: '168, 255, 196',
  /** 液体（隐藏层激活）—— 亮绿 */
  liquid: '78, 232, 128',
  /** 输出层液体（概率）—— 更亮的黄绿 */
  liquidOut: '140, 245, 140',
  /** 玻璃球体 */
  glassHi: 'rgba(34, 66, 92, 0.95)',
  glassMid: 'rgba(14, 32, 50, 0.96)',
  glassLo: 'rgba(7, 17, 29, 0.98)',
  /** 玻璃边缘 */
  rim: '168, 226, 240',
  /** 管道 */
  pipeCasing: '#1d3550',
  pipeEdge: 'rgba(150, 210, 232, 0.16)',
  pipeBore: '#0b1a28',
  /** 空管（贡献不显著，仍在参与真实计算） */
  pipeDeadCasing: '#152438',
  pipeDeadBore: '#0a141f',
  pipeCore: '92, 240, 126',
  pipeCoreOut: '150, 250, 150',
  warn: '#FF8E6E',
  ok: '#6FF0A0',
};

type Sprite = HTMLCanvasElement;

const spriteCache = new Map<string, Sprite>();

/** 预渲染径向光晕精灵（加色混合用，避免每帧造渐变） */
export function glowSprite(rgb: string, softness = 0.5): Sprite {
  const key = `${rgb}|${softness}`;
  const hit = spriteCache.get(key);
  if (hit) return hit;
  const size = 128;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, `rgba(${rgb}, 1)`);
  g.addColorStop(softness * 0.55, `rgba(${rgb}, 0.30)`);
  g.addColorStop(1, `rgba(${rgb}, 0)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  spriteCache.set(key, c);
  return c;
}

/** 背景星尘（确定性生成，静态） */
let stars: Float32Array | null = null;
export function starField(count = 90, w = 3600, h = 1800): Float32Array {
  if (stars) return stars;
  const arr = new Float32Array(count * 3);
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < count; i++) {
    arr[i * 3] = rand() * w - w / 2;
    arr[i * 3 + 1] = rand() * h - h / 2;
    arr[i * 3 + 2] = 0.1 + rand() * 0.4;
  }
  stars = arr;
  return arr;
}
