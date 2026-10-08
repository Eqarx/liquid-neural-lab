/**
 * 8-bit 灰度量化 —— 与训练端逐位一致。
 *
 * 训练脚本用 numpy 的 round()（四舍六入五取偶），JS 的 Math.round 是四舍五入，
 * 在恰好 x.5 的像素上会差 1/255。这里实现半偶舍入，保证两侧完全一致。
 */

export function roundHalfEven(v: number): number {
  const f = Math.floor(v);
  const d = v - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

export function quantizeU8(src: ArrayLike<number>, dst: Float32Array): Float32Array {
  for (let i = 0; i < src.length; i++) dst[i] = roundHalfEven(src[i] * 255) / 255;
  return dst;
}
