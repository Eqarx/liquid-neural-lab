# 第三方资源与许可

本项目代码以 [MIT](../LICENSE) 许可发布。以下第三方资源的许可与来源需要一并遵守：

| 资源 | 用途 | 许可 | 来源 |
| --- | --- | --- | --- |
| MNIST 手写数字数据集 | 训练与内置样本（`public/models/digit-mlp14/samples.json` 由测试集样本导出） | **CC BY-SA 3.0** | Yann LeCun, Corinna Cortes, Christopher Burges — <http://yann.lecun.com/exdb/mnist/> |
| Space Grotesk | 界面字体（`src/assets/fonts/space-grotesk-latin.woff2`，latin 子集） | **SIL Open Font License 1.1** | Florian Karsten — <https://github.com/floriankarsten/space-grotesk> |
| JetBrains Mono | 数值/代码字体（`src/assets/fonts/jetbrains-mono-latin.woff2`，latin 子集） | **SIL Open Font License 1.1** | JetBrains — <https://www.jetbrains.com/lp/mono/> |
| React / React DOM | UI 框架 | MIT | <https://react.dev> |
| D3 | 数据可视化工具（本项目用其比例尺与统计工具） | ISC | <https://d3js.org> |
| Vite / TypeScript / Vitest | 构建、类型检查、单元测试 | MIT | <https://vite.dev> · <https://www.typescriptlang.org> · <https://vitest.dev> |

## 关于模型权重

`public/models/digit-mlp14/weights.bin` 由本仓库的 `scripts/train_digit_mlp.py`（纯 numpy，无第三方深度学习框架）
在 MNIST 训练集上从零训练得到。权重文件本身按 MIT 许可随仓库提供，但**由 MNIST 派生的训练结果**在使用时
应遵守 MNIST 的 CC BY-SA 3.0 条款（署名 + 相同方式共享）。

## 关于画面中的"示意"部分

界面上每层只画出最有代表性的若干神经元与管道（示意化拓扑），但**所有显示的数值都来自真实前向传播**。
这一点在 `README.md`、引导页、图例、探索面板与专家面板中均有说明。
