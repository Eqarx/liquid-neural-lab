/**
 * v2 模型与输入管线测试
 *
 * 夹具（tests/fixtures/test-fixtures.json）由 scripts/train_digit_mlp.py 导出：
 * 64 个 MNIST 测试样本的 raw14 / raw28 / 模型输入 / 各层 z 与 a / probs。
 *
 * 覆盖：
 *  1) TS 前向传播与 Python 端逐值等价（每层 z、a、probs）
 *  2) 完整管线（14×14 原始像素 → 8-bit 量化 → 前向）预测与 Python 一致
 *  3) 28×28 → 14×14 下采样与训练端一致（浏览器载入内置样本走这条路径）
 *  4) 输入格缓存正确失效（快速连续改动不会用到旧值）
 *  5) 内置 12 个样本（含识别错误样本）与训练端记录一致
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { forwardModel, summarize, type ModelParams } from '../src/core/model';
import { InputGrid } from '../src/core/inputGrid';

const root = fileURLToPath(new URL('..', import.meta.url));

interface Fixture {
  raw14: number[];
  raw28: number[];
  label: number;
  modelInput: number[];
  z: number[][];
  a: number[][];
  probs: number[];
}

const fixtureFile = JSON.parse(readFileSync(join(root, 'tests', 'fixtures', 'test-fixtures.json'), 'utf8')) as {
  arch: number[];
  side: number;
  fixtures: Fixture[];
};
const fixtures = fixtureFile.fixtures;
const fixtureArch = fixtureFile.arch;

/** 模型清单：架构 / 参数量一律以它为准（测试不写死数字，避免模型换版时误报） */
const MODEL_DIR = join(root, 'public', 'models', 'digit-mlp14');
const manifestMeta = JSON.parse(readFileSync(join(MODEL_DIR, 'manifest.json'), 'utf8')) as {
  architecture: number[];
  side: number;
  id: string;
  totalParams: number;
  layout: { name: string; offset: number; count: number }[];
};

function loadParamsFromDisk(): ModelParams {
  const base = MODEL_DIR;
  const manifest = manifestMeta;
  const buf = readFileSync(join(base, 'weights.bin'));
  const data = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const layers = [];
  for (let i = 0; i + 1 < manifest.architecture.length; i++) {
    const w = manifest.layout.find((l) => l.name === `W${i + 1}`)!;
    const b = manifest.layout.find((l) => l.name === `b${i + 1}`)!;
    layers.push({
      w: data.subarray(w.offset, w.offset + w.count),
      b: data.subarray(b.offset, b.offset + b.count),
      inN: manifest.architecture[i],
      outN: manifest.architecture[i + 1],
    });
  }
  return { layers, side: manifest.side, arch: manifest.architecture, id: manifest.id };
}

const model = loadParamsFromDisk();

function gridInputFromRaw14(raw14: number[]): Float32Array {
  const grid = new InputGrid();
  grid.loadRaw14(raw14);
  return grid.modelInput();
}

describe('模型结构', () => {
  it('架构与参数数量符合清单', () => {
    // 不写死架构：由 manifest 推导（模型换版时测试不会假装通过，也不会误报）
    expect(model.arch).toEqual(manifestMeta.architecture);
    expect(model.arch[0]).toBe(196);
    expect(model.arch[model.arch.length - 1]).toBe(10);
    const params = model.layers.reduce((a, l) => a + l.w.length + l.b.length, 0);
    const expectParams = manifestMeta.architecture.reduce(
      (a, n, i) => (i + 1 < manifestMeta.architecture.length ? a + n * manifestMeta.architecture[i + 1] + manifestMeta.architecture[i + 1] : a),
      0,
    );
    expect(params).toBe(expectParams);
    expect(params).toBe(manifestMeta.totalParams);
    // 权重与夹具必须来自同一次训练
    expect(fixtureArch).toEqual(manifestMeta.architecture);
  });
});

describe('前向传播与 Python 端等价', () => {
  it('每层 z / a / probs 误差 < 1e-5（64 个夹具样本）', () => {
    let worst = 0;
    for (const f of fixtures) {
      const x = gridInputFromRaw14(f.raw14);
      const r = forwardModel(model, x);
      for (let li = 0; li < f.z.length; li++) {
        for (let i = 0; i < f.z[li].length; i++) {
          worst = Math.max(worst, Math.abs(r.z[li][i] - f.z[li][i]));
        }
        for (let i = 0; i < f.a[li].length; i++) {
          worst = Math.max(worst, Math.abs(r.a[li][i] - f.a[li][i]));
        }
      }
      for (let i = 0; i < 10; i++) worst = Math.max(worst, Math.abs(r.probs[i] - f.probs[i]));
    }
    console.log(`  前向最大误差: ${worst.toExponential(2)}`);
    expect(worst).toBeLessThan(1e-5);
  });

  it('完整管线预测与 Python 一致（64/64）', () => {
    let agree = 0;
    for (const f of fixtures) {
      const r = forwardModel(model, gridInputFromRaw14(f.raw14));
      const pred = r.probs.indexOf(Math.max(...Array.from(r.probs)));
      const py = f.probs.indexOf(Math.max(...f.probs));
      expect(pred).toBe(py);
      if (pred === py) agree++;
    }
    console.log(`  预测一致: ${agree}/${fixtures.length}`);
    expect(agree).toBe(fixtures.length);
  });

  it('末层概率之和为 1，且与 logits 一致', () => {
    const f = fixtures[0];
    const r = forwardModel(model, gridInputFromRaw14(f.raw14));
    const sum = Array.from(r.probs).reduce((a, b) => a + b, 0);
    expect(Math.abs(sum - 1)).toBeLessThan(1e-6);
    const s = summarize(r);
    expect(s.prediction).toBe(r.probs.indexOf(Math.max(...Array.from(r.probs))));
    expect(s.margin).toBeGreaterThanOrEqual(0);
  });
});

describe('输入管线', () => {
  it('28×28 下采样与训练端逐位一致（浏览器载入样本走此路径）', () => {
    let worst = 0;
    for (const f of fixtures) {
      const grid = new InputGrid();
      grid.loadRaw28(f.raw28);
      const x = grid.modelInput();
      for (let i = 0; i < 196; i++) {
        worst = Math.max(worst, Math.abs(x[i] - f.raw14[i] / 255));
      }
    }
    console.log(`  下采样最大误差（像素级）: ${worst.toExponential(2)}`);
    expect(worst).toBeLessThan(1e-6);
  });

  it('模型输入即所见像素（8-bit 量化，无裁剪无居中）', () => {
    const grid = new InputGrid();
    grid.loadRaw14(fixtures[0].raw14);
    const x = grid.modelInput();
    for (let i = 0; i < 196; i++) {
      expect(Math.abs(x[i] - fixtures[0].modelInput[i])).toBeLessThan(1e-6);
    }
  });

  it('输入缓存正确失效：连续改动不会读到旧值', () => {
    const grid = new InputGrid();
    expect(grid.modelInput()[0]).toBe(0);
    grid.stamp(0.5, 0.5, 1.15, 1, false);
    const a = grid.modelInput()[0];
    expect(a).toBeGreaterThan(0.3);
    grid.stamp(0.5, 0.5, 1.15, 1, true);
    const b = grid.modelInput()[0];
    expect(b).toBeLessThan(a);
    grid.clear();
    expect(grid.modelInput().every((v) => v === 0)).toBe(true);
  });

  it('笔刷是软边缘且不会写出越界值', () => {
    const grid = new InputGrid();
    grid.stroke(1, 1, 12, 12, 1.15, 1, false);
    const values = Array.from(grid.values);
    expect(Math.max(...values)).toBeLessThanOrEqual(1);
    expect(Math.min(...values)).toBeGreaterThanOrEqual(0);
    const center = values[1 * 14 + 1];
    expect(center).toBeGreaterThan(0.5);
  });
});

describe('内置样本', () => {
  it('浏览器管线预测与训练端记录一致（12/12，含识别错误样本）', () => {
    const file = JSON.parse(readFileSync(join(root, 'public', 'models', 'digit-mlp14', 'samples.json'), 'utf8')) as {
      samples: { id: string; label: number; prediction: number; correct: boolean; raw14: number[] }[];
    };
    let errors = 0;
    for (const s of file.samples) {
      const r = forwardModel(model, gridInputFromRaw14(s.raw14));
      const pred = r.probs.indexOf(Math.max(...Array.from(r.probs)));
      expect(pred).toBe(s.prediction);
      expect(s.correct).toBe(pred === s.label);
      if (pred !== s.label) errors++;
    }
    console.log(`  ${file.samples.length} 个样本一致；其中真实识别错误 ${errors} 个`);
    expect(errors).toBeGreaterThan(0); // 内置样本里必须有"模型会认错"的例子
  });
});
