/**
 * 下载自托管字体（Google Fonts，latin 子集，woff2 可变字体）。
 * 运行：node scripts/fetch_fonts.mjs
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'src', 'assets', 'fonts');
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const fonts = [
  { query: 'Space+Grotesk:wght@300..700', out: 'space-grotesk-latin.woff2' },
  { query: 'JetBrains+Mono:wght@400..800', out: 'jetbrains-mono-latin.woff2' },
];

await mkdir(outDir, { recursive: true });

for (const f of fonts) {
  const cssUrl = `https://fonts.googleapis.com/css2?family=${f.query}&display=swap`;
  const cssRes = await fetch(cssUrl, { headers: { 'User-Agent': UA } });
  if (!cssRes.ok) throw new Error(`css2 fetch failed ${cssRes.status} for ${f.query}`);
  const css = await cssRes.text();
  // 提取 latin 子集的 @font-face 块
  const latinBlock = css.match(/\/\* latin \*\/([\s\S]*?@font-face\s*\{[^}]*\})/);
  if (!latinBlock) throw new Error(`no latin block for ${f.query}`);
  const urlMatch = latinBlock[1].match(/url\((https:[^)]+\.woff2)\)/);
  if (!urlMatch) throw new Error(`no woff2 url for ${f.query}`);
  const fontRes = await fetch(urlMatch[1], { headers: { 'User-Agent': UA } });
  if (!fontRes.ok) throw new Error(`font fetch failed ${fontRes.status}`);
  const buf = Buffer.from(await fontRes.arrayBuffer());
  await writeFile(join(outDir, f.out), buf);
  console.log(`${f.out}: ${buf.length} bytes`);
}
console.log('fonts done');
