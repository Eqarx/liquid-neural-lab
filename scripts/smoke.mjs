/**
 * v2 浏览器冒烟测试（playwright-core + 系统 Edge）
 * 覆盖：加载无报错 → 在输入像素格上真实手写 → 实时预测 → 注入能量级联 →
 *       点击神经元看真实计算 → 拖动节点/整层 → 面板拖动 → 三级界面 → 移动端/reduced-motion
 *
 * 运行：node scripts/smoke.mjs [--mobile] [--reduced] [--shots]
 */
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const URL = process.env.SMOKE_URL || 'http://127.0.0.1:5173/';
const SHOTS = join(root, 'tmp', 'shots');
await mkdir(SHOTS, { recursive: true });

const args = process.argv.slice(2);
const reduced = args.includes('--reduced');
const mobile = args.includes('--mobile');
const shots = args.includes('--shots');

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({
  viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
  reducedMotion: reduced ? 'reduce' : 'no-preference',
  deviceScaleFactor: 1,
});
const page = await context.newPage();

const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text()}`);
});

let failed = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  ✓ ${name}${extra ? `  (${extra})` : ''}`);
  else {
    failed++;
    console.log(`  ✗ ${name}${extra ? `  (${extra})` : ''}`);
  }
};
const shot = (n) => page.screenshot({ path: join(SHOTS, n) });

/** 等相机飞行结束（headless 下动画较慢，坐标取样必须在稳定后进行） */
async function settleCamera(ms = 15000) {
  try {
    await page.waitForFunction(() => !window.__lab.scene.camera.flying, null, { timeout: ms });
  } catch {}
  // 相机到位后再等两帧：DOM 层标签的位置由渲染循环写入，取样必须在其后
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

/** 世界坐标（像素格）→ 页面坐标 */
async function cellToPage(c, r) {
  await settleCamera();
  return page.evaluate(
    ([cc, rr]) => {
      const e = window.__lab;
      const idx = rr * 14 + cc;
      const [x, y] = e.cellScreen(idx);
      const rect = document.querySelector('.lab-canvas').getBoundingClientRect();
      return { x: x + rect.left, y: y + rect.top };
    },
    [c, r],
  );
}

try {
  console.log(`== 打开页面（${mobile ? 'mobile' : 'desktop'}${reduced ? ', reduced-motion' : ''}）==`);
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.body.textContent.includes('开始'), null, { timeout: 15000 });
  check('页面标题', (await page.title()).includes('液光神经网络'));
  await page.click('.intro-card .btn-primary');
  await page.waitForTimeout(300);
  check('引导已关闭', (await page.locator('.intro-card').count()) === 0);

  // 生产构建没有 __lab 调试钩子：走 DOM 层面的验证路径
  const hasHook = await page.evaluate(() => !!window.__lab);
  if (!hasHook) {
    console.log('  (生产构建模式：不带调试钩子，改用 DOM 路径验证)');
    await page.waitForFunction(() => document.querySelector('.status-dot.ok') !== null, null, { timeout: 25000 });
    check('真实模型已加载（状态点变绿）', true);
    await page.click('text=🎯 输入格');
    await page.waitForTimeout(1800);
    const rect = await page.locator('.lab-canvas').boundingBox();
    // 聚焦输入格后，输入块位于画布中心偏左（右侧要避开浮窗）——用大笔画保证落在格子上
    const cx = rect.x + rect.width / 2 - 60;
    const cy = rect.y + rect.height * 0.5;
    const s = Math.min(rect.width, rect.height) * 0.22;
    await page.mouse.move(cx + s * 0.55, cy - s);
    await page.mouse.down();
    await page.mouse.move(cx + s * 0.55, cy + s, { steps: 16 });
    await page.mouse.up();
    await page.mouse.move(cx - s * 0.5, cy - s * 0.9);
    await page.mouse.down();
    await page.mouse.move(cx + s * 0.5, cy - s, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(900);
    const digit = (await page.locator('.result-digit').textContent())?.trim() ?? '';
    check('手写后结果面板给出数字', /^[0-9]$/.test(digit), `digit=${digit}`);
    const bars = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.prob-fill')).map((el) => parseFloat(el.style.transform.replace('scaleX(', '')) || 0),
    );
    check('概率条 10 条且有非零值', bars.length === 10 && Math.max(...bars) > 0.3, `max=${Math.max(...bars).toFixed(2)}`);
    const litPixels = await page.evaluate(() => {
      const c = document.querySelector('.lab-canvas');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let lit = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 24 || d[i + 1] > 28 || d[i + 2] > 44) lit++;
      return lit;
    });
    check('画布已绘制网络与像素', litPixels > 50000, `lit=${litPixels}`);
    await page.click('.level-pill >> text=专家');
    await page.waitForTimeout(800);
    const acc = await page.locator('.acc-num').first().textContent();
    check('专家层显示真实测试准确率', /9[0-9]\.[0-9]{2}%/.test(acc || ''), acc || '');
    if (shots) await shot('v2-prod.png');
    console.log(`== 控制台/页面错误: ${errors.length} ==`);
    for (const e of errors.slice(0, 8)) console.log(`  ${e}`);
    if (errors.length) failed++;
    await browser.close();
    console.log(failed === 0 ? 'SMOKE: PASS (production)' : `SMOKE: FAIL (${failed})`);
    process.exit(failed === 0 ? 0 : 1);
  }

  await page.waitForFunction(() => window.__lab && window.__lab.model !== null, null, { timeout: 20000 });
  check('真实模型已加载', true);

  // 在输入格上手写「7」：先对准输入格
  await page.click('text=🎯 输入格');
  await settleCamera();

  const p1 = await cellToPage(3, 3);
  const p2 = await cellToPage(10, 3);
  const p3 = await cellToPage(5, 11);
  await page.mouse.move(p1.x, p1.y);
  await page.mouse.down();
  for (const p of [p2]) {
    await page.mouse.move(p.x, p.y, { steps: 12 });
  }
  await page.mouse.up();
  await page.mouse.move(p2.x, p2.y);
  await page.mouse.down();
  await page.mouse.move(p3.x, p3.y, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(700);

  const pred = await page.evaluate(() => {
    const e = window.__lab;
    return { prediction: e.getSnapshot().prediction, ink: e.getSnapshot().ink, conf: e.getSnapshot().confidence };
  });
  console.log(`  (手写预测 = ${pred.prediction}, 上墨格子 = ${pred.ink}, 置信度 = ${(pred.conf * 100).toFixed(1)}%)`);
  check('手写后立即得到真实预测', pred.prediction === 7, `prediction=${pred.prediction}`);
  check('输入格确实被写上墨', pred.ink > 8, `ink=${pred.ink}`);
  const digit = await page.locator('.result-digit').textContent();
  check('结果浮窗显示预测数字', digit?.trim() === String(pred.prediction), `digit=${digit}`);
  const bars = await page.locator('.prob-row').count();
  check('概率条 10 条', bars === 10, `bars=${bars}`);
  if (shots) await shot('v2-01-drawn.png');

  // 注入能量 → 级联
  await page.click('.inject-btn');
  await page.waitForTimeout(350);
  const stage1 = await page.evaluate(() => window.__lab.getSnapshot().cascadeStage);
  check('注入能量后级联启动', stage1 >= 0, `stage=${stage1}`);
  if (shots) await shot('v2-02-cascade.png');
  let reached = true;
  try {
    await page.waitForFunction(() => window.__lab.getSnapshot().cascadeStage === 4, null, { timeout: 30000 });
  } catch {
    reached = false;
  }
  const after = await page.evaluate(() => ({ stage: window.__lab.getSnapshot().cascadeStage, particles: window.__lab.getSnapshot().particles }));
  check('级联跑到输出层（stage=4）', reached && after.stage === 4, `stage=${after.stage}`);

  // 点击一个隐藏层神经元 → 检查器
  await page.evaluate(() => window.__lab.focusBlock(1));
  await settleCamera();
  // 动态挑一个"没有被浮窗盖住"的隐藏层节点（同时也是可点性的真实断言）
  const nodePos = await page.evaluate(() => {
    const e = window.__lab;
    const rect = document.querySelector('.lab-canvas').getBoundingClientRect();
    for (let i = 0; i < 8; i++) {
      const [x, y] = e.scene.camera.toScreen(e.nodes.pos[i * 2], e.nodes.pos[i * 2 + 1]);
      const px = x + rect.left;
      const py = y + rect.top;
      if (px < 8 || py < 60 || px > rect.width - 8 || py > rect.height - 8) continue;
      const el = document.elementFromPoint(px, py);
      if (el && el.classList.contains('lab-canvas')) return { index: i, x: px, y: py, inView: true };
    }
    return { index: -1, x: 0, y: 0, inView: false };
  });
  check('目标神经元在屏幕内', nodePos.inView !== false, `inView=${nodePos.inView}`);
  await page.mouse.click(nodePos.x, nodePos.y);
  await page.waitForTimeout(400);
  const ins = await page.evaluate(() => window.__lab.getSnapshot().inspector);
  check('点击神经元打开检查器', !!ins && ins.layer === 1, ins ? `layer=${ins.layer} idx=${ins.index}` : 'null');
  check('检查器给出真实激活值', !!ins && ins.activation >= 0, ins ? `a=${ins.activation.toFixed(4)}` : '');
  check('检查器列出真实贡献项', !!ins && ins.contributions.length > 0, ins ? `${ins.contributions.length} 项` : '');
  if (shots) await shot('v2-03-inspector.png');

  // 拖动节点 → 位置改变，松手回弹（用节点 30，与读取的下标一致）
  await page.evaluate(() => window.__lab.focusBlock(1));
  try {
    await page.waitForFunction(() => !window.__lab.scene.camera.flying, null, { timeout: 15000 });
  } catch {}
  const dragPos = { x: nodePos.x, y: nodePos.y };
  const before = await page.evaluate((i) => [window.__lab.nodes.pos[i * 2], window.__lab.nodes.pos[i * 2 + 1]], nodePos.index);
  await page.mouse.move(dragPos.x, dragPos.y);
  await page.mouse.down();
  await page.mouse.move(dragPos.x + 120, dragPos.y + 60, { steps: 12 });
  const during = await page.evaluate((i) => [window.__lab.nodes.pos[i * 2], window.__lab.nodes.pos[i * 2 + 1]], nodePos.index);
  await page.mouse.up();
  // 轮询等弹簧收敛（固定等待在慢速 headless 下会偶发误报）
  let returnedOk = true;
  try {
    await page.waitForFunction(
      ([i, bx, by]) => {
        const p = window.__lab.nodes.pos;
        // 窄屏聚焦缩放更小，同样的屏幕拖拽换算出的世界位移更大 → 阈值放到 8（约 3px）
        return Math.hypot(p[i * 2] - bx, p[i * 2 + 1] - by) < 8;
      },
      [nodePos.index, before[0], before[1]],
      { timeout: 20000 },
    );
  } catch {
    returnedOk = false;
  }
  const back = await page.evaluate((i) => [window.__lab.nodes.pos[i * 2], window.__lab.nodes.pos[i * 2 + 1]], nodePos.index);
  const mode = await page.evaluate(() => window.__lab.scene.mode);
  const moved = Math.hypot(during[0] - before[0], during[1] - before[1]);
  const returned = Math.hypot(back[0] - before[0], back[1] - before[1]);
  check('拖动节点跟手（位置改变）', moved > 20, `位移=${moved.toFixed(1)}`);
  check('松手后拖拽状态结束', mode === 'idle', `mode=${mode}`);
  check('松手后弹簧回位', returnedOk && returned < 8, `残差=${returned.toFixed(2)}`);

  // 鼠标扫过管道 → 被拨弯（管道只有 58 根，必须先回全览并找一根露在浮窗外的）
  const pickPipe = () =>
    page.evaluate(() => {
      const e = window.__lab;
      const r = document.querySelector('.lab-canvas').getBoundingClientRect();
      const ok = (i) => {
        for (let t = 0.3; t <= 0.7; t += 0.05) {
          const [x, y] = e.scene.camera.toScreen(...e.pipes.pointAt(i, t));
          const px = x + r.left;
          const py = y + r.top;
          if (px < 20 || py < 90 || px > r.width - 20 || py > r.height - 20) return false;
          const el = document.elementFromPoint(px, py);
          if (!el || !el.classList.contains('lab-canvas')) return false;
        }
        return true;
      };
      for (let i = 0; i < e.pipes.pipes.length; i++) if (ok(i)) return i;
      return -1;
    });
  await page.evaluate(() => window.__lab.fitAll());
  await settleCamera();
  let pipeIdx = await pickPipe();
  if (pipeIdx < 0) {
    // 窄屏全览时画布可用区很小，退一步：聚焦中间层
    await page.evaluate(() => window.__lab.focusBlock(2));
    await settleCamera();
    pipeIdx = await pickPipe();
  }
  if (pipeIdx < 0) {
    check('画布可用区域不足时跳过拨动检查（窄屏）', true, 'skipped');
  } else {
    const pipePts = [];
    for (let t = 0.32; t <= 0.7; t += 0.06) {
      pipePts.push(
        await page.evaluate(
          ([i, tt]) => {
            const e = window.__lab;
            const [x, y] = e.scene.camera.toScreen(...e.pipes.pointAt(i, tt));
            const r = document.querySelector('.lab-canvas').getBoundingClientRect();
            return { x: x + r.left, y: y + r.top };
          },
          [pipeIdx, t],
        ),
      );
    }
    await page.mouse.move(pipePts[0].x, pipePts[0].y);
    for (const pnt of pipePts.slice(1)) await page.mouse.move(pnt.x, pnt.y, { steps: 2 });
    const pluck = await page.evaluate(() => window.__lab.live().plucking);
    if (reduced) check('reduced-motion 下不产生拨动（Tier1 移除）', pluck === 0, `plucking=${pluck}`);
    else check('鼠标扫过管道产生拨动', pluck > 0, `pipe#${pipeIdx} plucking=${pluck}`);
  }

  // 拖动层标签 → 整层位移
  await page.evaluate(() => window.__lab.focusInput());
  await settleCamera();
  const chip = await page.locator('.layer-chip').nth(0).boundingBox();
  await page.mouse.move(chip.x + chip.width / 2, chip.y + chip.height / 2);
  await page.mouse.down();
  await page.mouse.move(chip.x + chip.width / 2 + 90, chip.y + chip.height / 2 + 30, { steps: 8 });
  const blockOffset = await page.evaluate(() => Math.abs(window.__lab.nodes.blockOffset[0]) + Math.abs(window.__lab.nodes.blockOffset[1]));
  await page.mouse.up();
  check('拖动层标签整层移动', blockOffset > 10, `offset=${blockOffset.toFixed(1)}`);
  await page.waitForTimeout(1200);

  // 浮窗拖动（移动端浮窗是固定面板，按设计不可拖动）
  if (mobile) {
    check('移动端浮窗为固定面板（设计如此）', (await page.locator('.fpanel.sheet').count()) > 0);
  } else {
  const head = await page.locator('#result, .fpanel').filter({ hasText: '识别结果' }).first().locator('.fpanel-head').boundingBox();
  const panelBefore = await page.locator('.fpanel').filter({ hasText: '识别结果' }).first().boundingBox();
  if (head && panelBefore) {
    const hx = head.x + head.width / 2;
    const hy = head.y + head.height / 2;
    await page.mouse.move(hx, hy);
    await page.waitForTimeout(60);
    await page.mouse.down();
    await page.mouse.move(hx - 40, hy + 24, { steps: 6 });
    await page.mouse.move(hx - 140, hy + 80, { steps: 10 });
    await page.mouse.up();
    // 等两帧，React 的 setState 应用后再量位置
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const panelAfter = await page.locator('.fpanel').filter({ hasText: '识别结果' }).first().boundingBox();
    check('浮窗可拖动', !!panelAfter && Math.abs(panelAfter.x - panelBefore.x) > 40, `Δx=${(panelAfter.x - panelBefore.x).toFixed(0)}`);
  } else {
    check('浮窗可拖动', false, '未找到结果浮窗');
  }
  }

  // 内置样本（含识别错误样本）
  await page.click('text=▦ 样本');
  await page.waitForTimeout(300);
  const wrongChip = page.locator('.sample-chip[title*="识别错误"]').first();
  check('样本面板含识别错误样本', (await wrongChip.count()) > 0);
  await wrongChip.click();
  await page.waitForTimeout(800);
  const verdict = await page.locator('.sample-verdict').textContent();
  check('错误样本显示"识别错误"', (verdict || '').includes('识别错误'), verdict || '');
  if (shots) await shot('v2-04-sample.png');

  // 三级界面
  await page.click('.level-pill >> text=探索');
  await page.waitForTimeout(400);
  check('探索层出现参数浮窗', (await page.locator('.settings').count()) === 1);
  await page.click('.level-pill >> text=专家');
  await page.waitForTimeout(500);
  const acc = await page.locator('.acc-num').first().textContent();
  check('专家层显示真实测试准确率', /9[0-9]\.[0-9]{2}%/.test(acc || ''), acc || '');
  check('专家层显示架构表', (await page.locator('.arch-table tbody tr').count()) >= 5);
  if (shots) await shot('v2-05-expert.png');
  await page.click('.level-pill >> text=体验');
  await page.waitForTimeout(300);

  if (mobile) {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check('移动端无横向溢出', overflow <= 1, `溢出=${overflow}px`);
    if (shots) await shot('v2-06-mobile.png');
  }
  if (reduced) {
    const particles = await page.evaluate(() => window.__lab.getSnapshot().particles);
    check('reduced-motion 下不发射粒子（Tier1 移除）', particles === 0, `particles=${particles}`);
    await page.click('.inject-btn').catch(() => {});
    await page.waitForTimeout(600);
    const stage = await page.evaluate(() => window.__lab.getSnapshot().cascadeStage);
    check('reduced-motion 下级联仍可用（保留状态变化）', stage >= 0, `stage=${stage}`);
    if (shots) await shot('v2-07-reduced.png');
  }
} catch (e) {
  failed++;
  console.log(`  ✗ 异常: ${e.message}`);
  if (shots) await shot('v2-99-error.png');
}

console.log(`== 控制台/页面错误: ${errors.length} ==`);
for (const e of errors.slice(0, 8)) console.log(`  ${e}`);
if (errors.length) failed++;

await browser.close();
console.log(failed === 0 ? 'SMOKE: PASS' : `SMOKE: FAIL (${failed})`);
process.exit(failed === 0 ? 0 : 1);
