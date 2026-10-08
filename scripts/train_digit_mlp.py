# -*- coding: utf-8 -*-
"""
训练「液光实验台」版手写数字模型（v2）。

与 v1（784→128→64→10）的差异：
  * 输入 14×14 = 196（28×28 做 2×2 均值下采样），让每个像素都能连到每个神经元
  * 隐藏层 64 → 48 → 32（更多层、更少节点，便于排布与逐层注入演示）
  * 训练时强增强（±2px 平移、0.82–1.18 缩放、0.55–1.0 强度、膨胀/模糊）
    —— 因为浏览器端的模型输入 = 用户在 14×14 像素格上直接画出来的东西（不裁剪、不居中），
       必须对位置、大小、笔画粗细与浓度都鲁棒。

预处理（浏览器与训练端一致）：像素值 → round(x*255)/255（8-bit 量化）。

运行：python scripts/train_digit_mlp.py
"""
import gzip
import json
import os
import struct
import sys
import time

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "tmp", "mnist")
OUT_DIR = os.path.join(ROOT, "public", "models", "digit-mlp14")
FIX_DIR = os.path.join(ROOT, "tmp", "fixtures")
os.makedirs(OUT_DIR, exist_ok=True)
os.makedirs(FIX_DIR, exist_ok=True)

SEED = 20261008
SIDE = 14
ARCH = [SIDE * SIDE, 96, 64, 48, 10]
rng = np.random.default_rng(SEED)


# ---------------- 数据 ----------------

def load_idx(path):
    with gzip.open(path, "rb") as f:
        magic, n = struct.unpack(">II", f.read(8))
        if magic == 2051:
            rows, cols = struct.unpack(">II", f.read(8))
            data = np.frombuffer(f.read(n * rows * cols), dtype=np.uint8).reshape(n, rows, cols)
        elif magic == 2049:
            data = np.frombuffer(f.read(n), dtype=np.uint8)
        else:
            raise ValueError(f"bad magic {magic}")
    return data


def downsample14(images28):
    """28×28 → 14×14：整数域 2×2 均值 + 半偶舍入（numpy round），与浏览器 loadRaw28 完全一致。
    返回 [0,1] float32（= u8/255，即浏览器量化后的模型输入）。"""
    x = images28.reshape(-1, SIDE, 2, SIDE, 2).astype(np.int32)
    s = x.sum(axis=(2, 4))  # 0..1020
    u8 = np.round(s / 4.0).astype(np.uint8)  # numpy round = 四舍六入五取偶
    return (u8.astype(np.float32) / 255.0).astype(np.float32)


def quantize(x):
    """8-bit 灰度量化 —— 与浏览器推理完全一致"""
    return np.round(np.clip(x, 0.0, 1.0) * 255.0) / 255.0


# ---------------- 增强（全部向量化） ----------------

def augment(xb, mode="train"):
    """xb: (B,14,14) float32 in [0,1] → 增强后的同形状数组
    mode='train'：完整增强（缩放/平移/加粗/模糊/强度）
    mode='jitter'：仅模拟手写抖动（缩放/平移/强度）—— 用于评测报告
    """
    B = xb.shape[0]
    idx = np.arange(SIDE)
    c = (SIDE - 1) / 2.0

    # 1) 随机缩放（双线性，中心锚定）
    lo, hi = (0.85, 1.15) if mode == "train" else (0.88, 1.12)
    s = rng.uniform(lo, hi, size=B).astype(np.float32)
    src = (idx[None, :] - c) / s[:, None] + c
    src = np.clip(src, 0.0, SIDE - 1.0)
    i0 = np.floor(src).astype(np.int32)
    i1 = np.minimum(i0 + 1, SIDE - 1)
    f = (src - i0).astype(np.float32)
    bi = np.arange(B)[:, None, None]
    xb = (
        xb[bi, i0[:, :, None], i0[:, None, :]] * ((1 - f)[:, :, None] * (1 - f)[:, None, :])
        + xb[bi, i0[:, :, None], i1[:, None, :]] * ((1 - f)[:, :, None] * f[:, None, :])
        + xb[bi, i1[:, :, None], i0[:, None, :]] * (f[:, :, None] * (1 - f)[:, None, :])
        + xb[bi, i1[:, :, None], i1[:, None, :]] * (f[:, :, None] * f[:, None, :])
    )

    # 2) 随机平移 ±2（roll + 掩掉环绕）；np.roll 的 shift 不支持逐样本，故按位移分组处理
    dy = rng.integers(-2, 3, size=B)
    dx = rng.integers(-2, 3, size=B)
    idx_arr = np.arange(SIDE)
    for sy in (-2, -1, 0, 1, 2):
        for sx in (-2, -1, 0, 1, 2):
            m = (dy == sy) & (dx == sx)
            if not m.any():
                continue
            sub = np.roll(np.roll(xb[m], sy, axis=1), sx, axis=2)
            row_ok = ((idx_arr - sy) >= 0) & ((idx_arr - sy) < SIDE)
            col_ok = ((idx_arr - sx) >= 0) & ((idx_arr - sx) < SIDE)
            xb[m] = sub * row_ok[None, :, None] * col_ok[None, None, :]

    # 3) 笔画加粗（膨胀，仅训练）
    if mode == "train":
        dil = rng.random(B) < 0.30
        if dil.any():
            d = xb[dil]
            d = np.maximum.reduce([
                d,
                np.roll(d, 1, axis=1), np.roll(d, -1, axis=1),
                np.roll(d, 1, axis=2), np.roll(d, -1, axis=2),
            ])
            xb[dil] = d

        # 4) 模糊（仅训练）
        blur = rng.random(B) < 0.25
        if blur.any():
            b = xb[blur]
            acc = np.zeros_like(b)
            for a in (-1, 0, 1):
                for c2 in (-1, 0, 1):
                    acc += np.roll(np.roll(b, a, axis=1), c2, axis=2)
            xb[blur] = acc / 9.0

    # 5) 强度
    ilo, ihi = (0.60, 1.0) if mode == "train" else (0.65, 1.0)
    xb = xb * rng.uniform(ilo, ihi, size=(B, 1, 1)).astype(np.float32)
    return quantize(xb)


# ---------------- 模型 ----------------

def init_params(r):
    params = []
    for i in range(len(ARCH) - 1):
        fan_in = ARCH[i]
        w = (r.standard_normal((ARCH[i + 1], fan_in)) * np.sqrt(2.0 / fan_in)).astype(np.float32)
        b = np.zeros(ARCH[i + 1], dtype=np.float32)
        params.append(w)
        params.append(b)
    return params


def forward(params, x):
    """返回 (每层加权和 zs, 每层输出 acts, 概率 probs)；acts[-1] 即 probs"""
    zs, acts = [], []
    a = x
    for i in range(0, len(params), 2):
        w, b = params[i], params[i + 1]
        z = a @ w.T + b
        zs.append(z)
        if i == len(params) - 2:
            ez = np.exp(z - z.max(axis=1, keepdims=True))
            a = ez / ez.sum(axis=1, keepdims=True)
        else:
            a = np.maximum(z, 0.0)
        acts.append(a)
    return zs, acts, acts[-1]


def backward(params, x, y, zs, acts, probs, l2):
    """通用反向传播：参数排布 [W1,b1,W2,b2,...]，层 L 的权重下标 2(L-1)、偏置 2(L-1)+1"""
    B = x.shape[0]
    n_layers = len(zs)
    grads = [None] * len(params)
    delta = probs.copy()
    delta[np.arange(B), y] -= 1.0
    delta /= B
    for L in range(n_layers, 0, -1):
        wi = 2 * (L - 1)
        bi = wi + 1
        a_prev = acts[L - 2] if L >= 2 else x
        grads[bi] = delta.sum(axis=0)
        grads[wi] = delta.T @ a_prev + l2 * params[wi]
        if L > 1:
            delta = (delta @ params[wi]) * (zs[L - 2] > 0)
    return grads


def sgd_momentum(params, grads, vels, lr, momentum=0.9):
    """SGD + 动量（v1 中已验证收敛的优化器）"""
    for i in range(len(params)):
        vels[i] = momentum * vels[i] - lr * grads[i]
        params[i] += vels[i]


def clip_grads(grads, max_norm=5.0):
    """全局范数梯度裁剪：稳定训练，防止偶发爆梯度"""
    total = 0.0
    for g in grads:
        total += float(np.sum(g * g))
    norm = np.sqrt(total)
    if norm > max_norm:
        scale = max_norm / (norm + 1e-12)
        for g in grads:
            g *= scale
    return norm


def evaluate(params, x, y, batch=1024):
    correct = 0
    preds = np.empty(len(y), dtype=np.int64)
    for i in range(0, len(x), batch):
        _, _, p = forward(params, x[i:i + batch])
        pr = p.argmax(axis=1)
        preds[i:i + batch] = pr
        correct += int((pr == y[i:i + batch]).sum())
    return correct / len(y), preds


# ---------------- 主流程 ----------------

def main():
    t0 = time.time()
    print(f"[1/6] 载入 MNIST 并下采样到 {SIDE}×{SIDE} …", flush=True)
    tr_img = load_idx(os.path.join(DATA_DIR, "train-images-idx3-ubyte.gz"))
    tr_lab = load_idx(os.path.join(DATA_DIR, "train-labels-idx1-ubyte.gz")).astype(np.int64)
    te_img = load_idx(os.path.join(DATA_DIR, "t10k-images-idx3-ubyte.gz"))
    te_lab = load_idx(os.path.join(DATA_DIR, "t10k-labels-idx1-ubyte.gz")).astype(np.int64)
    tr_x = downsample14(tr_img)
    te_x = downsample14(te_img)
    print(f"  train {tr_x.shape} test {te_x.shape}", flush=True)

    # 验证集：训练集尾部 5000
    val_x, val_y = tr_x[-5000:], tr_lab[-5000:]
    trn_x, trn_y = tr_x[:-5000], tr_lab[:-5000]

    print(f"[2/6] 训练 MLP {'-'.join(map(str, ARCH))} …", flush=True)
    EPOCHS, BATCH, LR0, L2 = 70, 128, 0.06, 1e-4
    FINE_TUNE_FROM = 50  # 末段改用温和增强，把"干净样本"的精度收回来
    PATIENCE = 14        # 耐心值需大于"早停点到微调点"的距离
    params = init_params(rng)
    vels = [np.zeros_like(p) for p in params]
    history, best_val, best_params, bad = [], -1.0, None, 0

    for epoch in range(1, EPOCHS + 1):
        ep0 = time.time()
        # 预热 3 轮后余弦衰减到 0.002
        if epoch <= 3:
            lr = LR0 * (epoch / 3)
        else:
            prog = (epoch - 3) / max(1, EPOCHS - 3)
            lr = 0.002 + (LR0 - 0.002) * 0.5 * (1 + np.cos(np.pi * prog))
        order = rng.permutation(len(trn_x))
        aug_mode = "train" if epoch < FINE_TUNE_FROM else "jitter"
        for b in range(0, len(trn_x), BATCH):
            bi = order[b:b + BATCH]
            xb = augment(trn_x[bi], mode=aug_mode).reshape(len(bi), -1)
            yb = trn_y[bi]
            zs, acts, p = forward(params, xb)
            grads = backward(params, xb, yb, zs, acts, p, L2)
            clip_grads(grads, 5.0)
            sgd_momentum(params, grads, vels, lr)
        val_acc, _ = evaluate(params, val_x.reshape(len(val_x), -1), val_y)
        history.append({"epoch": epoch, "lr": round(float(lr), 5), "val_acc": round(float(val_acc), 5)})
        print(f"  epoch {epoch:2d}/{EPOCHS} lr={lr:.4f} val_acc={val_acc:.4f} ({time.time()-ep0:.1f}s)", flush=True)
        if val_acc > best_val + 1e-4:
            best_val, best_params, bad = val_acc, [p.copy() for p in params], 0
        else:
            bad += 1
            if bad >= PATIENCE:
                print(f"  早停于第 {epoch} 轮", flush=True)
                break
    params = best_params

    print("[3/6] 评测 …", flush=True)
    te_flat = te_x.reshape(len(te_x), -1)
    clean_acc, preds = evaluate(params, te_flat, te_lab)
    # 手写抖动评测（平移/缩放/强度 —— 模拟自由手写的位置与大小差异）
    jb = np.concatenate([augment(te_x[i:i + 2000], mode="jitter") for i in range(0, len(te_x), 2000)])
    jitter_acc, _ = evaluate(params, jb.reshape(len(jb), -1), te_lab)
    print(f"  干净测试集准确率 = {clean_acc:.4f} ({clean_acc*100:.2f}%)", flush=True)
    print(f"  手写抖动测试集准确率 = {jitter_acc:.4f} ({jitter_acc*100:.2f}%)", flush=True)
    per_class = [float((preds[te_lab == d] == d).mean()) for d in range(10)]
    conf = np.zeros((10, 10), dtype=np.int64)
    for t, p in zip(te_lab, preds):
        conf[t, p] += 1

    print("[4/6] 导出权重 …", flush=True)
    flat = np.concatenate([p.reshape(-1).astype("<f4") for p in params])
    with open(os.path.join(OUT_DIR, "weights.bin"), "wb") as f:
        f.write(flat.tobytes())
    layout, off = [], 0
    for i in range(0, len(params), 2):
        w, b = params[i], params[i + 1]
        layout.append({"name": f"W{i//2+1}", "shape": list(w.shape), "offset": off, "count": int(w.size)})
        off += int(w.size)
        layout.append({"name": f"b{i//2+1}", "shape": list(b.shape), "offset": off, "count": int(b.size)})
        off += int(b.size)
    manifest = {
        "id": f"digit-mlp14-{'-'.join(str(n) for n in ARCH)}",  # 由 ARCH 生成，避免与架构脱节
        "version": 2,
        "side": SIDE,
        "architecture": ARCH,
        "activation": ["none"] + ["relu"] * (len(ARCH) - 2) + ["softmax"],
        "layout": layout,
        "totalParams": int(sum(p.size for p in params)),
        "dtype": "float32",
        "byteOrder": "little-endian",
        "inputPipeline": "painted 14x14 grid -> 8-bit quantize (round(x*255)/255) -> flatten 196",
        "training": {
            "dataset": "MNIST (train 60000 / test 10000), 2x2 mean downsample to 14x14",
            "epochs": len(history),
            "batchSize": BATCH,
            "optimizer": "SGD + momentum 0.9, grad-norm clip 5.0",
            "lrSchedule": "warmup 3 epochs to 0.06, then cosine to 0.002",
            "l2": L2,
            "init": "He normal",
            "augmentation": "scale 0.85-1.15, shift ±2px, dilation p=0.30, blur p=0.25, intensity 0.60-1.0",
            "validation": "5000 held out from train",
            "bestValAccuracy": round(float(best_val), 5),
            "cleanTestAccuracy": round(float(clean_acc), 5),
            "jitterTestAccuracy": round(float(jitter_acc), 5),
        },
    }
    with open(os.path.join(OUT_DIR, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    metrics = {
        "dataset": "MNIST test set (10000 samples, CC BY-SA 3.0, LeCun/Cortes/Burges)",
        "cleanTestAccuracy": round(float(clean_acc), 5),
        "jitterTestAccuracy": round(float(jitter_acc), 5),
        "perClassAccuracy": [round(c, 5) for c in per_class],
        "confusionMatrix": conf.tolist(),
        "history": history,
        "trainedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
        "seed": SEED,
        "modelSizeBytes": int(flat.nbytes),
        "architecture": ARCH,
    }
    for d in (OUT_DIR, FIX_DIR):
        with open(os.path.join(d, "metrics.json"), "w", encoding="utf-8") as f:
            json.dump(metrics, f, ensure_ascii=False, indent=2)

    print("[5/6] 导出内置样本（含真实识别错误样本）…", flush=True)
    te_x14_u8 = np.round(te_x * 255).astype(np.uint8)
    probs_all = []
    for i in range(0, len(te_flat), 1024):
        _, _, p = forward(params, quantize(te_flat[i:i + 1024]))
        probs_all.append(p)
    probs_all = np.concatenate(probs_all)
    preds_q = probs_all.argmax(axis=1)
    chosen = []
    for d in range(10):
        cand = np.where((preds_q == te_lab) & (te_lab == d))[0]
        chosen.append(int(cand[np.argmax(probs_all[cand].max(axis=1))]))
    wrong = np.where(preds_q != te_lab)[0]
    margins = np.array([np.sort(probs_all[i])[::-1][0] - np.sort(probs_all[i])[::-1][1] for i in wrong])
    for i in wrong[np.argsort(margins)[:2]]:
        chosen.append(int(i))
    samples = []
    for i in chosen:
        p = probs_all[i]
        order = np.argsort(p)[::-1]
        samples.append({
            "id": f"mnist-{i}",
            "label": int(te_lab[i]),
            "prediction": int(preds_q[i]),
            "correct": bool(preds_q[i] == te_lab[i]),
            "top3": [{"digit": int(d), "prob": float(p[d])} for d in order[:3]],
            "raw14": te_x14_u8[i].reshape(-1).tolist(),
            "raw28": te_img[i].reshape(-1).tolist(),
            "source": "MNIST test set (CC BY-SA 3.0, LeCun et al.)",
        })
    with open(os.path.join(OUT_DIR, "samples.json"), "w", encoding="utf-8") as f:
        json.dump({"count": len(samples), "samples": samples}, f, ensure_ascii=False)

    print("[6/6] 导出数值等价夹具 …", flush=True)
    fix_idx = rng.choice(len(te_img), size=64, replace=False)
    fixtures = []
    for i in fix_idx:
        i = int(i)
        x = quantize(te_flat[i]).reshape(1, -1)
        zs, acts, p = forward(params, x)
        fixtures.append({
            "raw14": te_x14_u8[i].reshape(-1).tolist(),
            "raw28": te_img[i].reshape(-1).tolist(),
            "label": int(te_lab[i]),
            "modelInput": np.round(x[0], 7).tolist(),
            "z": [np.round(z[0], 7).tolist() for z in zs],
            "a": [np.round(a[0], 7).tolist() for a in acts],
            "probs": np.round(p[0], 7).tolist(),
        })
    with open(os.path.join(FIX_DIR, "test-fixtures.json"), "w", encoding="utf-8") as f:
        json.dump({"count": len(fixtures), "arch": ARCH, "side": SIDE, "fixtures": fixtures}, f, ensure_ascii=False)
    # 同时写一份到 tests/fixtures（vitest 直接读取，避免与训练产物脱节）
    tf_dir = os.path.join(ROOT, "tests", "fixtures")
    os.makedirs(tf_dir, exist_ok=True)
    with open(os.path.join(tf_dir, "test-fixtures.json"), "w", encoding="utf-8") as f:
        json.dump({"count": len(fixtures), "arch": ARCH, "side": SIDE, "fixtures": fixtures}, f, ensure_ascii=False)

    print(f"DONE in {time.time()-t0:.1f}s  clean={clean_acc:.4f} jitter={jitter_acc:.4f}", flush=True)


if __name__ == "__main__":
    main()
