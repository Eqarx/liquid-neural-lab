# 免费部署到 GitHub Pages（含英文版 / English below）

> 目标：把这个仓库变成一个**在线可访问的网址**，不需要服务器、不需要备案、零费用。
> 仓库已备好所需文件，你只要做三步：建仓库 → 推送 → 打开 Pages。

---

## 一、准备（本仓库已完成的）

| 文件 | 作用 |
| --- | --- |
| `.github/workflows/deploy.yml` | 自动构建 + 部署工作流（push 到 `main` 时触发，也可在 Actions 页手动跑） |
| `vite.config.ts` 里的 `base: './'` | 用**相对路径**，因此部署到 `https://<用户名>.github.io/<仓库名>/` 这种子路径无需改配置 |
| `public/.nojekyll` | 让 Pages 不启用 Jekyll（否则下划线开头的文件可能被吞掉） |
| `.gitignore` | 排除 `node_modules/`、`dist/`、`tmp/`、`backups/`、`__pycache__/` 等，保证仓库干净 |
| `LICENSE` / `THIRD-PARTY.md` | MIT 许可 + 第三方资源（MNIST CC BY-SA 3.0、字体 OFL）声明 |

## 二、三步上线

### 1. 建仓库并推送

在 <https://github.com/new> 新建仓库 **`liquid-neural-lab`**（public），**不要**勾选 README/LICENSE/gitignore（已有）。
然后在项目根目录执行：

```bash
git init
git add .
git commit -m "feat: 液光神经网络 · 手写数字实验室（196→96→64→48→10，测试集 97.91%）"
git branch -M main
git remote add origin https://github.com/Eqarx/liquid-neural-lab.git
git push -u origin main
```

> 如果你想换仓库名，把上面两处 `liquid-neural-lab` 一起改掉，并把 `package.json` 里的
> `homepage` / `repository` 字段同步改一下（README 顶部的徽章链接同理）。

### 2. 打开 Pages

仓库 **Settings → Pages → Build and deployment → Source** 选 **GitHub Actions**（一次即可）。

### 3. 等构建完成

推送后到 **Actions** 页看 `Deploy to GitHub Pages` 跑完（约 1–2 分钟），网址就是：

```
https://eqarx.github.io/liquid-neural-lab/
```

之后每次 `git push` 到 `main` 都会自动重新构建部署。

## 三、常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| 页面打开是 404 | Settings → Pages 里 Source 忘记选 **GitHub Actions**；或仓库是 private（免费账号 Pages 需 public） |
| 页面白屏 / 资源 404 | 手动改过 `base`（本仓库用 `'./'`，**不要**改成 `'/'`，否则子路径部署会挂） |
| Actions 报 `pnpm install --frozen-lockfile` 失败 | 你改过依赖但没提交 `pnpm-lock.yaml`；本地跑一次 `pnpm install` 后一起提交 |
| Actions 报 esbuild 相关错误 | `pnpm-workspace.yaml` 里 `allowBuilds: esbuild: true` 被删了 |
| 想用自己的域名 | Settings → Pages → Custom domain 填域名，并在域名商处加 CNAME 记录 |
| 首次部署后仍是旧版本 | Pages 有 CDN 缓存，等 1–2 分钟或 `Ctrl/Cmd + Shift + R` 强刷 |

## 四、其它免费方案（都支持这个 `dist/` 产物）

| 平台 | 免费额度要点 | 适合 |
| --- | --- | --- |
| **GitHub Pages** | public 仓库免费、无流量限制（软限制约 100 GB/月）、自带 HTTPS | 本仓库默认方案，零配置 |
| **Cloudflare Pages** | 无流量限制、全球 CDN、支持 private 仓库、每月 500 次构建 | 需要更快 CDN 或私有仓库 |
| **Netlify** | 100 GB/月带宽、300 构建分钟/月、支持 PR 预览 | 想要预览部署 |
| **Vercel** | 100 GB/月带宽、自动识别 Vite | 前后端一体项目 |
| **Render / Surge** | 静态站点免费 | 备用 |

它们的共同配置都是：**构建命令 `pnpm build`（或 `npm run build`）、产物目录 `dist`**。
参考：[Vite 官方《Deploying a Static Site》](https://vite.dev/guide/static-deploy)、
[GitHub Pages 文档](https://docs.github.com/en/pages)。

---
---

# Free deployment to GitHub Pages (English)

Three steps: create the repo → push → enable Pages. No server, no cost.

## What is already prepared

| File | Purpose |
| --- | --- |
| `.github/workflows/deploy.yml` | Build + deploy workflow (runs on push to `main`, or manually from the Actions tab) |
| `base: './'` in `vite.config.ts` | Relative asset paths, so a project page at `https://<user>.github.io/<repo>/` works unchanged |
| `public/.nojekyll` | Stops GitHub Pages from running Jekyll (which can swallow underscore-prefixed files) |
| `.gitignore` | Keeps `node_modules/`, `dist/`, `tmp/`, `backups/`, `__pycache__/` out of the repo |
| `LICENSE`, `THIRD-PARTY.md` | MIT license plus third-party notices (MNIST CC BY-SA 3.0, fonts OFL) |

## Steps

1. Create a public repo named **`liquid-neural-lab`** at <https://github.com/new> (do **not** add README/LICENSE/.gitignore).
2. Push this project:

```bash
git init
git add .
git commit -m "feat: liquid neural lab — handwritten digit visualizer (97.91% test accuracy)"
git branch -M main
git remote add origin https://github.com/Eqarx/liquid-neural-lab.git
git push -u origin main
```

3. In the repo: **Settings → Pages → Build and deployment → Source: GitHub Actions**.

After the `Deploy to GitHub Pages` workflow finishes (~1–2 min), the site is live at:

```
https://eqarx.github.io/liquid-neural-lab/
```

Every later push to `main` redeploys automatically.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| 404 | Pages source not set to **GitHub Actions**, or the repo is private (free Pages needs a public repo) |
| Blank page / 404 assets | You changed `base`; keep it as `'./'` for project pages |
| `pnpm install --frozen-lockfile` fails in CI | Commit `pnpm-lock.yaml` after changing dependencies locally |
| esbuild install error in CI | Restore `allowBuilds: esbuild: true` in `pnpm-workspace.yaml` |
| Custom domain | Settings → Pages → Custom domain (add a CNAME record at your DNS provider) |

## Alternatives (same `dist/` output)

**Cloudflare Pages** (unlimited bandwidth, supports private repos) · **Netlify** (100 GB/month, PR previews) ·
**Vercel** (auto-detects Vite) · **Render / Surge**. Configure all of them with build command
`pnpm build` and output directory `dist`.
See [Vite: Deploying a Static Site](https://vite.dev/guide/static-deploy) and the
[GitHub Pages docs](https://docs.github.com/en/pages).
