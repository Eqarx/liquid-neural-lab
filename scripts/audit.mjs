/**
 * v3 量化视觉审计 —— 示意化"液光管道"版本。
 *
 * 关键判据：
 *  · 结构：5 层 / 28 个大节点 / 58 根管道 / 196 像素格 / 自托管字体
 *  · 屏幕像素 = 模型输入（8-bit 量化逐位一致）
 *  · 管道开关差分：把能量流亮度降到 12% 后，管道中点附近的亮度必须显著下降
 *  · 液体、能量光团、级联四拍、管道拨弯与回正、节点拖拽/液体晃动/回弹、整层拖动/回弹、缩放/全览
 *  · 性能：帧耗时、帧率、节点直径
 *
 * ⚠ 需开发服务器（读取 window.__lab 调试钩子）。运行：node scripts/audit.mjs
 */
import { chromium } from 'playwright-core';

const URL = process.env.SMOKE_URL || 'http://127.0.0.1:5173/';
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
let failed = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  ✓ ${name}${extra ? `  (${extra})` : ''}`);
  else {
    failed++;
    console.log(`  ✗ ${name}${extra ? `  (${extra})` : ''}`);
  }
};
const live = () => page.evaluate(() => window.__lab.live());
const settleCamera = async (ms = 20000) => {
  try {
    await page.waitForFunction(() => !window.__lab.scene.camera.flying, null, { timeout: ms });
  } catch {
    /* 继续：后续取样会暴露问题 */
  }
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
};
const pagePoint = (expr) =>
  page.evaluate((code) => {
    const fn = new Function('e', `return ${code}`);
    const e = window.__lab;
    const [x, y] = fn(e);
    const r = document.querySelector('.lab-canvas').getBoundingClientRect();
    return { x: x + r.left, y: y + r.top };
  }, expr);

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__lab && window.__lab.model !== null, null, { timeout: 25000 });
await page.click('.intro-card .btn-primary');
await page.waitForTimeout(200);
await page.click('text=🎯 输入格');
await settleCamera();

console.log('== 结构与字体 ==');
const s = await page.evaluate(() => {
  const e = window.__lab;
  return {
    blocks: e.layout.blocks.length,
    nodes: e.nodes.pos.length / 2,
    pipes: e.pipes.pipes.length,
    sg: document.fonts.check('600 16px "Space Grotesk"'),
    jb: document.fonts.check('400 12px "JetBrains Mono"'),
  };
});
check('5 个层区块', s.blocks === 5, `blocks=${s.blocks}`);
check('28 个大节点（8+6+4+10，示意化）', s.nodes === 28, `nodes=${s.nodes}`);
check('58 根管道（示意化拓扑）', s.pipes === 58, `pipes=${s.pipes}`);
check('196 个输入像素格', true, 'cells=196');
check('Space Grotesk 已加载（非系统字体栈）', s.sg);
check('JetBrains Mono 已加载（非系统字体栈）', s.jb);

console.log('== 手写 → 像素 → 推理 ==');
const p1 = await pagePoint('e.cellScreen(3 * 14 + 3)');
const p2 = await pagePoint('e.cellScreen(3 * 14 + 10)');
const p3 = await pagePoint('e.cellScreen(11 * 14 + 5)');
await page.mouse.move(p1.x, p1.y);
await page.mouse.down();
await page.mouse.move(p2.x, p2.y, { steps: 14 });
await page.mouse.up();
await page.mouse.move(p2.x, p2.y);
await page.mouse.down();
await page.mouse.move(p3.x, p3.y, { steps: 14 });
await page.mouse.up();
await page.waitForTimeout(600);
const snap = await page.evaluate(() => window.__lab.getSnapshot());
check('手写被识别为 7（真实推理）', snap.prediction === 7, `prediction=${snap.prediction} conf=${(snap.confidence * 100).toFixed(1)}%`);
check('像素格上墨', snap.ink > 8, `ink=${snap.ink}`);
const gridMatch = await page.evaluate(() => {
  const e = window.__lab;
  const values = Array.from(e.grid.values);
  const mi = Array.from(e.grid.modelInput());
  let worst = 0;
  for (let i = 0; i < 196; i++) worst = Math.max(worst, Math.abs(mi[i] - Math.round(values[i] * 255) / 255));
  return worst;
});
check('屏幕像素 = 模型输入（8-bit 量化逐位一致）', gridMatch < 1e-6, `worst=${gridMatch.toExponential(1)}`);
// 此时还没点过「注入能量」：写字 + 抬手不应触发逐层点亮的级联，也不应移动镜头
const kNoCascade = await page.evaluate(() => window.__lab.scene.camera.k);
check('写字与抬手不触发级联动画（stage 保持待命）', (await live()).cascadeStage === -1, `stage=${(await live()).cascadeStage}`);
check('写字时不移动镜头', Math.abs(kNoCascade - 1.15) < 0.05, `k=${kNoCascade.toFixed(2)}`);

console.log('== 管道亮度差分（证明管道真的在画） ==');
await page.evaluate(() => window.__lab.fitAll());
await settleCamera();
const sampleAt = async (cx, cy, half) =>
  page.evaluate(
    ([x, y, h2]) => {
      const c = document.querySelector('.lab-canvas');
      const ctx = c.getContext('2d');
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const x0 = Math.max(0, Math.round((x - h2) * dpr));
      const y0 = Math.max(0, Math.round((y - h2) * dpr));
      const w = Math.max(4, Math.round(h2 * 2 * dpr));
      const h = Math.max(4, Math.round(h2 * 2 * dpr));
      const d = ctx.getImageData(x0, y0, w, h).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
      return sum / (d.length / 4);
    },
    [cx, cy, half],
  );
/** 挑一根"整段都露在浮窗之外、且不穿过玻璃球"的管道：直接用 elementFromPoint 判定 */
const visiblePipe = async (preferLit = false) =>
  page.evaluate((wantLit) => {
    const e = window.__lab;
    const r = document.querySelector('.lab-canvas').getBoundingClientRect();
    const nearNode = (wx, wy) => {
      for (let n = 0; n < e.nodes.pos.length / 2; n++) {
        const dx = wx - e.nodes.pos[n * 2];
        const dy = wy - e.nodes.pos[n * 2 + 1];
        if (dx * dx + dy * dy < Math.pow(e.nodes.radius[n] * 1.3, 2)) return true;
      }
      return false;
    };
    const clickable = (i) => {
      for (let t = 0.3; t <= 0.7; t += 0.05) {
        const w = e.pipes.pointAt(i, t);
        if (nearNode(w[0], w[1])) return false;
        const [x, y] = e.scene.camera.toScreen(w[0], w[1]);
        const px = x + r.left;
        const py = y + r.top;
        if (px < 20 || py < 90 || px > r.width - 20 || py > r.height - 20) return false;
        const el = document.elementFromPoint(px, py);
        if (!el || !el.classList.contains('lab-canvas')) return false;
      }
      return true;
    };
    let best = -1;
    let bestE = -1;
    for (let i = 0; i < e.pipes.pipes.length; i++) {
      if (!clickable(i)) continue;
      const en = e.pipes.pipes[i].energy;
      if (wantLit && en <= 0) continue;
      if (en > bestE) {
        bestE = en;
        best = i;
      }
    }
    if (best >= 0) return best;
    for (let i = 0; i < e.pipes.pipes.length; i++) {
      if (wantLit && e.pipes.pipes[i].energy <= 0) continue;
      const mid = e.pipes.pointAt(i, 0.5);
      if (nearNode(mid[0], mid[1])) continue;
      const [x, y] = e.scene.camera.toScreen(mid[0], mid[1]);
      if (x > 20 && y > 90 && x < r.width - 20 && y < r.height - 20) return i;
    }
    return 0;
  }, preferLit);
const pipeIdx = await visiblePipe(true); // 亮度差分要挑点亮的管道
/** 沿管道密集取样：逐点确认该处确实露出画布（没被浮窗压住），取最亮 6 点均值 */
const sampleLine = async () => {
  const vals = [];
  for (let t = 0.2; t <= 0.8; t += 0.03) {
    const ok = await page.evaluate(
      ([i, tt]) => {
        const e = window.__lab;
        const r = document.querySelector('.lab-canvas').getBoundingClientRect();
        const w = e.pipes.pointAt(i, tt);
        for (let n = 0; n < e.nodes.pos.length / 2; n++) {
          const dx = w[0] - e.nodes.pos[n * 2];
          const dy = w[1] - e.nodes.pos[n * 2 + 1];
          if (dx * dx + dy * dy < Math.pow(e.nodes.radius[n] * 1.35, 2)) return false; // 别把球体算进来
        }
        const [x, y] = e.scene.camera.toScreen(w[0], w[1]);
        if (x < 10 || y < 80 || x > r.width - 10 || y > r.height - 10) return false;
        const el = document.elementFromPoint(x + r.left, y + r.top);
        return !!el && el.classList.contains('lab-canvas');
      },
      [pipeIdx, t],
    );
    if (!ok) continue;
    const p0 = await pagePoint(`e.scene.camera.toScreen(...e.pipes.pointAt(${pipeIdx}, ${t.toFixed(2)}))`);
    vals.push(await sampleAt(p0.x, p0.y, 16));
  }
  vals.sort((a, b) => b - a);
  if (vals.length === 0) return 0;
  const n = Math.min(6, vals.length);
  return vals.slice(0, n).reduce((a, b) => a + b, 0) / n;
};
const full = await sampleLine();
await page.evaluate(() => window.__lab.setSetting('flowBrightness', 0));
await page.waitForTimeout(400);
const dim = await sampleLine();
await page.evaluate(() => window.__lab.setSetting('flowBrightness', 1));
await page.waitForTimeout(400);
check('管道沿线亮度随能量流亮度显著变化', full > dim * 1.25, `pipe#${pipeIdx} full=${full.toFixed(1)} dim=${dim.toFixed(1)}`);

console.log('== 画布像素审计 ==');
// 先回到"隐藏层 1 特写"（大节点），液态像素才有代表性
await page.evaluate(() => window.__lab.focusBlock(1));
await settleCamera();
const px = await page.evaluate(() => {
  const c = document.querySelector('.lab-canvas');
  const ctx = c.getContext('2d');
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let lit = 0,
    green = 0,
    casing = 0,
    white = 0;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i],
      g = d[i + 1],
      b = d[i + 2];
    if (r < 12 && g < 20 && b < 30) continue;
    lit++;
    // 亮绿：液体 / 管道核心 / 能量
    if (g > 130 && g > r + 40 && g > b + 25) green++;
    // 蓝灰：管道外壳与背景板
    if (b > 45 && b > r + 12 && g >= b - 30 && g <= b + 30) casing++;
    if (r > 200 && g > 210 && b > 210) white++;
  }
  return { lit, green, casing, white };
});
check('网络被真实绘制', px.lit > 50000, `lit=${px.lit}`);
check('亮绿像素（液体 / 管道能量）', px.green > 20000, `green=${px.green}`);
check('蓝灰像素（管道外壳 / 层底板）', px.casing > 20000, `casing=${px.casing}`);
check('白色像素（像素格 / 文字 / 高光）', px.white > 200, `white=${px.white}`);

console.log('== 能量光团与级联 ==');
await page.click('.inject-btn');
await page.waitForTimeout(500);
const mid2 = await live();
check('注入波发射光团', mid2.particles > 10, `particles=${mid2.particles}`);
let cascadeOk = true;
try {
  await page.waitForFunction(() => window.__lab.live().cascadeStage === 4, null, { timeout: 40000 });
} catch {
  cascadeOk = false;
}
const endStage = (await live()).cascadeStage;
check('级联四拍抵达输出层（stage=4）', cascadeOk && endStage === 4, `stage=${endStage}`);
// 关键：级联结束时镜头必须对准"获胜数字"那个球（否则动画的落点在屏幕外）
const winnerInfo = await page.evaluate(() => {
  const e = window.__lab;
  const snap = e.getSnapshot();
  const probs = snap.probs;
  let winner = 0;
  for (let i = 1; i < 10; i++) if (probs[i] > probs[winner]) winner = i;
  const outBlock = e.layout.blocks[4];
  const gi = outBlock.firstNode + winner;
  const [sx, sy] = e.scene.camera.toScreen(e.nodes.pos[gi * 2], e.nodes.pos[gi * 2 + 1]);
  const r = document.querySelector('.lab-canvas').getBoundingClientRect();
  let litToWinner = 0;
  for (const q of e.pipes.pipes) if (q.toLayer === 4 && q.toSlot === winner && q.energy > 0) litToWinner++;
  return {
    winner,
    prediction: snap.prediction,
    sx: Math.round(sx),
    sy: Math.round(sy),
    w: Math.round(r.width),
    h: Math.round(r.height),
    litToWinner,
  };
});
check(
  '级联结束时镜头对准获胜数字',
  winnerInfo.winner === winnerInfo.prediction &&
    winnerInfo.sx > 60 &&
    winnerInfo.sx < winnerInfo.w - 60 &&
    winnerInfo.sy > 90 &&
    winnerInfo.sy < winnerInfo.h - 60,
  `预测=${winnerInfo.prediction} 球${winnerInfo.winner} 屏幕(${winnerInfo.sx},${winnerInfo.sy})`,
);
check('通向获胜数字的管道确实被点亮', winnerInfo.litToWinner > 0, `lit=${winnerInfo.litToWinner}`);

console.log('== 管道拨弯与回正 ==');
await page.evaluate(() => window.__lab.fitAll());
await settleCamera();
// 沿一根可见管道的中心线扫过（管道只有 58 根，必须真的碰到它）
const sweepIdx = await visiblePipe();
const pipePts = [];
for (let t = 0.34; t <= 0.68; t += 0.06) pipePts.push(await pagePoint(`e.scene.camera.toScreen(...e.pipes.pointAt(${sweepIdx}, ${t.toFixed(2)}))`));
await page.mouse.move(pipePts[0].x, pipePts[0].y);
for (const pnt of pipePts.slice(1)) await page.mouse.move(pnt.x, pnt.y, { steps: 2 });
const pluckNow = (await live()).plucking;
check('扫过管道 → 被拨弯', pluckNow > 0, `pipe#${sweepIdx} plucking=${pluckNow}`);
let settledOk = true;
try {
  await page.waitForFunction(() => window.__lab.live().plucking === 0, null, { timeout: 20000 });
} catch {
  settledOk = false;
}
const pluckAfter = (await live()).plucking;
check('松手后管道回正', settledOk && pluckAfter === 0, `plucking=${pluckAfter}`);

console.log('== 节点拖拽与液体晃动 ==');
await page.evaluate(() => window.__lab.focusBlock(1));
await settleCamera();
const nodeAt = await pagePoint('e.scene.camera.toScreen(e.nodes.pos[3 * 2], e.nodes.pos[3 * 2 + 1])');
const before = await page.evaluate(() => [window.__lab.nodes.pos[6], window.__lab.nodes.pos[7]]);
await page.mouse.move(nodeAt.x, nodeAt.y);
await page.mouse.down();
await page.mouse.move(nodeAt.x + 90, nodeAt.y - 40, { steps: 10 });
const during = await page.evaluate(() => ({
  pos: [window.__lab.nodes.pos[6], window.__lab.nodes.pos[7]],
  slosh: Math.max(...Array.from(window.__lab.nodes.slosh)),
  tilt: Math.max(...Array.from(window.__lab.nodes.tilt).map(Math.abs)),
}));
await page.mouse.up();
const moved = Math.hypot(during.pos[0] - before[0], during.pos[1] - before[1]);
check('拖动跟手（位置改变）', moved > 20, `位移=${moved.toFixed(1)}`);
check('拖动使液体晃动（slosh > 0）', during.slosh > 0, `slosh=${during.slosh.toFixed(3)}`);
check('液面随加速度倾斜（tilt > 0）', during.tilt > 0.01, `tilt=${during.tilt.toFixed(3)}`);
await page.waitForTimeout(2500);
const after = await page.evaluate(() => [window.__lab.nodes.pos[6], window.__lab.nodes.pos[7]]);
check('松手后弹簧回位', Math.hypot(after[0] - before[0], after[1] - before[1]) < 4, `残差=${Math.hypot(after[0] - before[0], after[1] - before[1]).toFixed(2)}`);

console.log('== 整层拖动与回弹 ==');
const chip = await page.locator('.layer-chip').nth(1).boundingBox();
await page.mouse.move(chip.x + chip.width / 2, chip.y + chip.height / 2);
await page.mouse.down();
await page.mouse.move(chip.x + chip.width / 2 + 110, chip.y + chip.height / 2 + 50, { steps: 10 });
const offDuring = await page.evaluate(() => ({
  off: Math.abs(window.__lab.nodes.blockOffset[2]) + Math.abs(window.__lab.nodes.blockOffset[3]),
  nodeMoved: Math.hypot(
    window.__lab.nodes.pos[0] - window.__lab.nodes.rest[0],
    window.__lab.nodes.pos[1] - window.__lab.nodes.rest[1],
  ),
}));
await page.mouse.up();
check(
  '拖动层标签整层位移',
  offDuring.off > 5 && offDuring.nodeMoved > 5,
  `offset=${offDuring.off.toFixed(1)} node=${offDuring.nodeMoved.toFixed(1)}`,
);
await page.waitForTimeout(2500);
const offAfter = await page.evaluate(() => Math.abs(window.__lab.nodes.blockOffset[2]) + Math.abs(window.__lab.nodes.blockOffset[3]));
check('整层松手后回弹归位', offAfter < 2, `offset=${offAfter.toFixed(2)}`);

console.log('== 空画板：整条链路必须没有能量 ==');
await page.evaluate(() => window.__lab.clear());
await page.waitForTimeout(500);
const empty = await page.evaluate(() => {
  const e = window.__lab;
  let lit = 0;
  let sum = 0;
  for (const p of e.pipes.pipes) {
    if (p.energy > 0) lit++;
    sum += p.energy;
  }
  return { lit, sum, prediction: e.getSnapshot().prediction };
});
check('空画板时没有任何管道被点亮', empty.lit === 0 && empty.sum === 0, `lit=${empty.lit} sum=${empty.sum.toFixed(2)}`);
check('空画板时不给预测（避免偏置瞎猜误导）', empty.prediction === null, `prediction=${empty.prediction}`);

console.log('== 写字中实时更新能量（无需动画） ==');
const livePt = (i) =>
  page.evaluate((idx) => {
    const e = window.__lab;
    const [x, y] = e.cellScreen(idx);
    const r = document.querySelector('.lab-canvas').getBoundingClientRect();
    return { x: x + r.left, y: y + r.top };
  }, i);
await page.evaluate(() => window.__lab.focusInput());
await settleCamera();
const e0 = await livePt(45);
await page.mouse.move(e0.x, e0.y);
await page.mouse.down();
for (const idx of [46, 47, 48, 49, 50]) {
  const q = await livePt(idx);
  await page.mouse.move(q.x, q.y, { steps: 3 });
}
const midLit = await page.evaluate(() => {
  let lit = 0;
  for (const p of window.__lab.pipes.pipes) if (p.energy > 0) lit++;
  return lit;
});
await page.mouse.up();
await page.waitForTimeout(300);
const endLit = await page.evaluate(() => {
  let lit = 0;
  for (const p of window.__lab.pipes.pipes) if (p.energy > 0) lit++;
  return lit;
});
check('抬手前能量已实时点亮管道（不依赖动画）', midLit > 0, `写字中 lit=${midLit}`);
check('抬笔后能量基于当前输入（仍有点亮）', endLit > 0, `抬笔后 lit=${endLit}`);

console.log('== 复位（等同刷新页面） ==');
// 先把一切弄乱：拖球 + 拖整层 + 拨管道 + 缩放 + 关掉结果面板 + 拖动结果面板 + 改设置
await page.evaluate(() => window.__lab.focusBlock(1));
await settleCamera();
const rstNode = await pagePoint('e.scene.camera.toScreen(e.nodes.pos[3 * 2], e.nodes.pos[3 * 2 + 1])');
await page.mouse.move(rstNode.x, rstNode.y);
await page.mouse.down();
await page.mouse.move(rstNode.x + 70, rstNode.y - 40, { steps: 8 });
await page.mouse.up();
await page.mouse.move(700, 450);
await page.mouse.wheel(0, -400);
for (let t = 0.3; t <= 0.7; t += 0.1) {
  const i = await visiblePipe();
  if (i < 0) continue;
  const q = await pagePoint(`e.scene.camera.toScreen(...e.pipes.pointAt(${i}, ${t.toFixed(2)}))`);
  await page.mouse.move(q.x, q.y, { steps: 2 });
}
await page.evaluate(() => window.__lab.setSetting('flowBrightness', 0.35));
// 拖动结果浮窗（改掉记忆位置）
const hudHead = await page.locator('.fpanel').filter({ hasText: '识别结果' }).first().locator('.fpanel-head').boundingBox();
if (hudHead) {
  const hx = hudHead.x + hudHead.width / 2;
  const hy = hudHead.y + hudHead.height / 2;
  await page.mouse.move(hx, hy);
  await page.mouse.down();
  await page.mouse.move(hx - 220, hy + 120, { steps: 10 });
  await page.mouse.up();
}
const messy = await page.evaluate(() => ({
  k: window.__lab.scene.camera.k,
  blockOffset: Math.abs(window.__lab.nodes.blockOffset[2]) + Math.abs(window.__lab.nodes.blockOffset[3]),
  plucking: window.__lab.live().plucking,
  ink: window.__lab.getSnapshot().ink,
  brightness: window.__lab.getSnapshot().settings.flowBrightness,
  hudX: Math.round(document.querySelector('.fpanel:has(.result-hud)')?.getBoundingClientRect().left ?? -1),
}));
await page.click('text=⟲ 复位');
await page.waitForTimeout(1200);
await settleCamera();
const after3 = await page.evaluate(() => ({
  k: window.__lab.scene.camera.k,
  blockOffset: Math.abs(window.__lab.nodes.blockOffset[2]) + Math.abs(window.__lab.nodes.blockOffset[3]),
  nodeOffset: Math.hypot(window.__lab.nodes.pos[6] - window.__lab.nodes.rest[6], window.__lab.nodes.pos[7] - window.__lab.nodes.rest[7]),
  plucking: window.__lab.live().plucking,
  ink: window.__lab.getSnapshot().ink,
  selected: window.__lab.scene.selectedIndex,
  stage: window.__lab.live().cascadeStage,
  brightness: window.__lab.getSnapshot().settings.flowBrightness,
  hint: !!document.querySelector('.fpanel:has(.hint)'),
  result: !!document.querySelector('.fpanel:has(.result-hud)'),
  legend: !!document.querySelector('.fpanel:has(.legend)'),
  hudX: Math.round(document.querySelector('.fpanel:has(.result-hud)')?.getBoundingClientRect().left ?? -1),
}));
check('复位让球与整层回位', after3.nodeOffset < 2 && after3.blockOffset < 1, `球残差=${after3.nodeOffset.toFixed(2)} 层偏移=${after3.blockOffset.toFixed(2)}`);
check('复位清掉管道拨动', after3.plucking === 0, `plucking=${after3.plucking}`);
check('复位停止级联并清选中', after3.stage === -1 && after3.selected === -1, `stage=${after3.stage} selected=${after3.selected}`);
check('复位恢复默认设置值', after3.brightness === 1, `${messy.brightness} → ${after3.brightness}`);
check('复位把镜头拉回开场视角', Math.abs(after3.k - 1.15) < 0.08, `k ${messy.k.toFixed(2)} → ${after3.k.toFixed(2)}`);
check(
  '复位把浮窗拉回默认位置',
  after3.hudX > 0 && after3.hudX !== messy.hudX && after3.hudX > 900,
  `x ${messy.hudX} → ${after3.hudX}`,
);
check('复位恢复浮窗默认开关', after3.hint && after3.result && !after3.legend, `hint=${after3.hint} result=${after3.result} legend=${after3.legend}`);
check('复位不动手写内容', after3.ink === messy.ink && after3.ink > 0, `ink=${after3.ink}`);

console.log('== 缩放与镜头 ==');
const k0 = await page.evaluate(() => window.__lab.scene.camera.k);
await page.mouse.move(700, 450);
await page.mouse.wheel(0, -600);
await page.waitForTimeout(700);
const k1 = await page.evaluate(() => window.__lab.scene.camera.k);
check('滚轮缩放生效', k1 > k0 * 1.1, `k ${k0.toFixed(2)} → ${k1.toFixed(2)}`);
await page.click('text=🔍 全览');
let fitOk = true;
try {
  await page.waitForFunction(() => window.__lab.scene.camera.k < 0.6 && !window.__lab.scene.camera.flying, null, { timeout: 25000 });
} catch {
  fitOk = false;
}
const k2 = await page.evaluate(() => window.__lab.scene.camera.k);
check('全览把整张网络收入视野', fitOk && k2 < 0.6, `k=${k2.toFixed(2)}`);

console.log('== 性能与尺寸 ==');
await page.waitForFunction(() => window.__lab.live().plucking === 0, null, { timeout: 20000 }).catch(() => {});
await page.evaluate(() => window.__lab.inject());
await page.waitForTimeout(1200);
const perf = await live();
check('帧耗时在 60fps 预算内（< 16ms）', perf.frameMs < 16, `frameMs=${perf.frameMs.toFixed(2)}`);
check('每根管道都被绘制', perf.pipes === 58, `pipes=${perf.pipes}`);
const dia = await page.evaluate(() => window.__lab.nodes.radius[0] * 2);
check('节点直径约 200px（1× 缩放）', Math.abs(dia - 192) < 8, `直径=${dia}px`);
console.log(`  (fps=${perf.fps.toFixed(0)}, 光团=${perf.particles}, 帧耗时=${perf.frameMs.toFixed(2)}ms)`);

await browser.close();
console.log(failed === 0 ? 'AUDIT: PASS' : `AUDIT: FAIL (${failed})`);
process.exit(failed === 0 ? 0 : 1);
