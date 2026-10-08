# -*- coding: utf-8 -*-
"""数值梯度检查：验证 scripts/train_digit_mlp.py 的反向传播实现正确。

用小架构 + 中央差分对照解析梯度，逐参数比较最大相对误差。
运行：python scripts/gradcheck.py
"""
import importlib.util
import os
import sys

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location("train_mod", os.path.join(ROOT, "scripts", "train_digit_mlp.py"))
T = importlib.util.module_from_spec(spec)
spec.loader.exec_module(T)

# 用小架构做检查（比真实架构更快，且覆盖同样的通用反向传播路径）
T.ARCH = [8, 7, 5, 4, 3]
L2 = 0.02
rng = np.random.default_rng(7)
params = [p.astype(np.float64) for p in T.init_params(rng)]  # float64：中央差分不受 float32 噪声干扰

B = 6
x = rng.random((B, T.ARCH[0])).astype(np.float64)
y = rng.integers(0, T.ARCH[-1], size=B).astype(np.int64)


def loss_of(ps):
    zs, acts, p = T.forward(ps, x)
    ce = -np.log(np.clip(p[np.arange(B), y], 1e-12, None)).mean()
    reg = 0.5 * L2 * sum(float(np.sum(w * w)) for w in ps[0::2])
    return float(ce + reg)


zs, acts, p = T.forward(params, x)
grads = T.backward(params, x, y, zs, acts, p, L2)

eps = 1e-6
worst = 0.0
worst_at = None
checked = 0
for pi, (param, grad) in enumerate(zip(params, grads)):
    flat = param.reshape(-1)
    gflat = grad.reshape(-1)
    # 每个参数张量抽样检查
    idxs = list(range(min(24, flat.size))) + list(rng.choice(flat.size, size=min(24, flat.size), replace=False))
    for i in idxs:
        orig = flat[i]
        flat[i] = orig + eps
        lp = loss_of(params)
        flat[i] = orig - eps
        lm = loss_of(params)
        flat[i] = orig
        num = (lp - lm) / (2 * eps)
        ana = gflat[i]
        denom = max(1e-9, abs(num) + abs(ana))
        rel = abs(num - ana) / denom
        if rel > worst:
            worst = rel
            worst_at = (pi, int(i), float(num), float(ana))
        checked += 1

print(f"检查参数点: {checked}  最大相对误差: {worst:.3e}  最差位置: {worst_at}")
print("GRADCHECK PASS" if worst < 1e-6 else "GRADCHECK FAIL")
sys.exit(0 if worst < 1e-6 else 1)
