/** 模型资源加载：manifest / weights.bin / samples.json / metrics.json */

import type { ModelLayer, ModelParams } from './model';

export interface ModelManifest {
  id: string;
  version: number;
  side: number;
  architecture: number[];
  activation: string[];
  layout: { name: string; shape: number[]; offset: number; count: number }[];
  totalParams: number;
  inputPipeline: string;
  training: Record<string, unknown>;
}

export interface Sample {
  id: string;
  label: number;
  prediction: number;
  correct: boolean;
  top3: { digit: number; prob: number }[];
  raw14: number[];
  raw28: number[];
  source: string;
}

export interface Metrics {
  dataset: string;
  cleanTestAccuracy: number;
  jitterTestAccuracy: number;
  perClassAccuracy: number[];
  confusionMatrix: number[][];
  history: { epoch: number; lr: number; val_acc: number }[];
  trainedAt: string;
  seed: number;
  modelSizeBytes: number;
  architecture: number[];
}

export const MODEL_BASE = 'models/digit-mlp14';

let manifestCache: Promise<ModelManifest> | null = null;
let modelCache: Promise<ModelParams> | null = null;
let samplesCache: Promise<Sample[]> | null = null;
let metricsCache: Promise<Metrics> | null = null;

function getJson<T>(url: string, what: string): Promise<T> {
  return fetch(url).then((r) => {
    if (!r.ok) throw new Error(`${what} 加载失败: HTTP ${r.status}`);
    return r.json() as Promise<T>;
  });
}

export function loadManifest(): Promise<ModelManifest> {
  if (!manifestCache) manifestCache = getJson<ModelManifest>(`${MODEL_BASE}/manifest.json`, '模型清单');
  return manifestCache;
}

export function loadModel(): Promise<ModelParams> {
  if (modelCache) return modelCache;
  modelCache = (async () => {
    const manifest = await loadManifest();
    const res = await fetch(`${MODEL_BASE}/weights.bin`);
    if (!res.ok) throw new Error(`权重加载失败: HTTP ${res.status}`);
    const data = new Float32Array(await res.arrayBuffer());
    const layers: ModelLayer[] = [];
    for (let i = 0; i + 1 < manifest.architecture.length; i++) {
      const w = manifest.layout.find((l) => l.name === `W${i + 1}`);
      const b = manifest.layout.find((l) => l.name === `b${i + 1}`);
      if (!w || !b) throw new Error(`清单缺少第 ${i + 1} 层权重`);
      layers.push({
        w: data.subarray(w.offset, w.offset + w.count),
        b: data.subarray(b.offset, b.offset + b.count),
        inN: manifest.architecture[i],
        outN: manifest.architecture[i + 1],
      });
    }
    // 形状自检
    for (let i = 0; i < layers.length; i++) {
      if (layers[i].w.length !== layers[i].inN * layers[i].outN) {
        throw new Error(`第 ${i + 1} 层权重尺寸与架构不符`);
      }
    }
    return { layers, side: manifest.side, arch: manifest.architecture, id: manifest.id };
  })();
  return modelCache;
}

export function loadSamples(): Promise<Sample[]> {
  if (!samplesCache) {
    samplesCache = getJson<{ samples: Sample[] }>(`${MODEL_BASE}/samples.json`, '内置样本').then((f) => f.samples);
  }
  return samplesCache;
}

export function loadMetrics(): Promise<Metrics> {
  if (!metricsCache) metricsCache = getJson<Metrics>(`${MODEL_BASE}/metrics.json`, '评测数据');
  return metricsCache;
}
