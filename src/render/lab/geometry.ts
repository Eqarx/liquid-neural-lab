/**
 * 实验台几何 —— 示意化布局（v3）。
 *
 * 设计目标：看得清 > 面面俱到。
 *   · 输入：真实 14×14 像素格（你写的就是模型输入）
 *   · 每层只摆少量"大节点"（直径约 200px @ 1×），由真实激活值决定显示哪些神经元
 *   · 管道从输入层背面（右侧汇流排）接出，不遮挡输入格
 *
 * 层与层之间用粗管道连接，能量在管道里流动 → 节点内液面上升。
 */

export type BlockKey = 'input' | 'l1' | 'l2' | 'l3' | 'out';

export interface BlockGeom {
  key: BlockKey;
  label: string;
  sub: string;
  x: number;
  y: number;
  w: number;
  h: number;
  cols: number;
  rows: number;
  pitch: number;
  radius: number;
  count: number;
  /** 该块首个节点在全局节点数组中的下标（输入块为 -1） */
  firstNode: number;
  /** 权重层下标：0=输入，1..4 = W1..W4 的目标层 */
  layerIndex: number;
}

export interface LabLayout {
  blocks: BlockGeom[];
  /** 全部大节点：8 + 6 + 4 + 10 = 28 */
  nodeRest: Float32Array;
  nodeBlock: Uint8Array;
  nodeLocal: Uint16Array;
  nodeRadius: Float32Array;
  inputX0: number;
  inputY0: number;
  inputCell: number;
  /** 汇流排（管道起点所在竖条）中心 x 与半高 */
  manifoldX: number;
  manifoldH: number;
  totalW: number;
  totalH: number;
  centers: number[];
}

/** 每层显示的大节点数量（示意化，非全部神经元） */
export const SLOT_COUNT = { l1: 8, l2: 6, l3: 4, out: 10 } as const;
/**
 * 各层节点阵列（列×行）—— 隐藏层 1/2 为 2 列，隐藏层 3 收成 **1 列 4 个**（更聚焦），输出层 2 列。
 * 宽块会让层与层之间的管道左右摊开、互相挤压；竖列则让管道近乎水平地成束流动。
 */
const GRID: Record<'l1' | 'l2' | 'l3' | 'out', [number, number]> = {
  l1: [2, 4],
  l2: [2, 3],
  l3: [1, 4],
  out: [2, 5],
};

const NODE_PITCH = 290;
const NODE_RADIUS = 96;
const INPUT_CELL = 26;
const GAP = 250;
const MANIFOLD_GAP = 56;

export const NODE_TOTAL = SLOT_COUNT.l1 + SLOT_COUNT.l2 + SLOT_COUNT.l3 + SLOT_COUNT.out; // 28
export const OUT_FIRST = SLOT_COUNT.l1 + SLOT_COUNT.l2 + SLOT_COUNT.l3; // 18

export function computeLayout(): LabLayout {
  const inputW = INPUT_CELL * 14;
  /** 各层纵向错落（竖列布局下幅度小一些，保持管道成束） */
  const STAGGER = [0, -52, 44, -30, 16];
  const sizes: { key: BlockKey; w: number; h: number }[] = [{ key: 'input', w: inputW, h: inputW }];
  (['l1', 'l2', 'l3', 'out'] as const).forEach((k) => {
    const [cols, rows] = GRID[k];
    sizes.push({ key: k, w: cols * NODE_PITCH, h: rows * NODE_PITCH });
  });

  // 输入块 → 汇流排 → 各层
  const manifoldX = inputW + MANIFOLD_GAP;
  const centers: number[] = [inputW / 2];
  let cursor = manifoldX + GAP;
  sizes.slice(1).forEach((s) => {
    centers.push(cursor + s.w / 2);
    cursor += s.w + GAP;
  });
  const totalW = cursor - GAP + 40;
  const totalH = Math.max(...sizes.map((s) => s.h)) + 2 * Math.max(...STAGGER.map(Math.abs));

  const blocks: BlockGeom[] = [];
  let firstNode = 0;
  sizes.forEach((s, i) => {
    const key = s.key;
    const isInput = key === 'input';
    const [cols, rows] = isInput ? [14, 14] : GRID[key as 'l1' | 'l2' | 'l3' | 'out'];
    const count = isInput ? 196 : SLOT_COUNT[key as 'l1' | 'l2' | 'l3' | 'out'];
    const label = isInput
      ? '输入像素'
      : key === 'l1'
        ? '隐藏层 1'
        : key === 'l2'
          ? '隐藏层 2'
          : key === 'l3'
            ? '隐藏层 3'
            : '输出层';
    blocks.push({
      key,
      label,
      sub: isInput ? '14×14 = 196（在这里写）' : `${count} 个代表神经元`,
      x: centers[i],
      y: STAGGER[i] ?? 0,
      w: s.w,
      h: s.h,
      cols,
      rows,
      pitch: isInput ? INPUT_CELL : NODE_PITCH,
      radius: isInput ? INPUT_CELL * 0.46 : NODE_RADIUS,
      count,
      firstNode: isInput ? -1 : firstNode,
      layerIndex: isInput ? 0 : i,
    });
    if (!isInput) firstNode += count;
  });

  const nodeRest = new Float32Array(NODE_TOTAL * 2);
  const nodeBlock = new Uint8Array(NODE_TOTAL);
  const nodeLocal = new Uint16Array(NODE_TOTAL);
  const nodeRadius = new Float32Array(NODE_TOTAL);
  blocks.forEach((b, bi) => {
    if (b.firstNode < 0) return;
    for (let r = 0; r < b.rows; r++) {
      for (let c = 0; c < b.cols; c++) {
        const local = r * b.cols + c;
        const gi = b.firstNode + local;
        nodeRest[gi * 2] = b.x + (c - (b.cols - 1) / 2) * b.pitch;
        nodeRest[gi * 2 + 1] = b.y + (r - (b.rows - 1) / 2) * b.pitch;
        nodeBlock[gi] = bi;
        nodeLocal[gi] = local;
        nodeRadius[gi] = b.radius;
      }
    }
  });

  const inputBlock = blocks[0];
  const inputX0 = inputBlock.x - inputBlock.w / 2;
  const inputY0 = inputBlock.y - inputBlock.h / 2;

  return {
    blocks,
    nodeRest,
    nodeBlock,
    nodeLocal,
    nodeRadius,
    inputX0,
    inputY0,
    inputCell: INPUT_CELL,
    manifoldX,
    manifoldH: Math.min(3 * NODE_PITCH, inputW * 0.9),
    totalW,
    totalH,
    centers,
  };
}

export function cellCenter(layout: LabLayout, index: number): [number, number] {
  const r = Math.floor(index / 14);
  const c = index % 14;
  return [layout.inputX0 + (c + 0.5) * layout.inputCell, layout.inputY0 + (r + 0.5) * layout.inputCell];
}

/** 世界坐标 → 输入格坐标（可越界，供笔刷使用） */
export function toCellCoords(layout: LabLayout, wx: number, wy: number): [number, number] {
  return [(wx - layout.inputX0) / layout.inputCell, (wy - layout.inputY0) / layout.inputCell];
}

export function inInputBlock(layout: LabLayout, wx: number, wy: number, pad = 0): boolean {
  const b = layout.blocks[0];
  return wx >= b.x - b.w / 2 - pad && wx <= b.x + b.w / 2 + pad && wy >= b.y - b.h / 2 - pad && wy <= b.y + b.h / 2 + pad;
}
