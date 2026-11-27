'use strict';
// OCR TEST용 스캔본 만들기: node scripts/make-scan-docs.js  →  test-docs/11_스캔본_OCR/
//  test-docs의 PDF를 이미지로 바꾼 뒤(글자층 없음) 약간 기울이고 흐리게 해서 '스캔한 문서'처럼 만든다.
//  Chromium 필요(CHROMIUM_PATH 또는 기본 경로). playwright-core가 있으면 사용(TG_PLAYWRIGHT로 경로 지정 가능).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { PDFParse } = require('pdf-parse');

const ROOT = path.join(__dirname, '..', 'test-docs');
const OUT = path.join(ROOT, '11_스캔본_OCR');
const PICK = [
  ['01_공사계약서', 'TEST-01_'], ['01_공사계약서', 'TEST-04_'], ['01_공사계약서', 'TEST-06_'], ['01_공사계약서', 'TEST-07_'], ['01_공사계약서', 'TEST-10_'],
  ['03_기술지도계약서', 'TEST-01_'], ['03_기술지도계약서', 'TEST-04_'], ['03_기술지도계약서', 'TEST-05_'], ['03_기술지도계약서', 'TEST-06_'], ['03_기술지도계약서', 'TEST-10_'],
];

function chromiumPath() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const base = '/opt/pw-browsers';
  const dir = fs.existsSync(base) ? fs.readdirSync(base).find((d) => /^chromium-\d+$/.test(d)) : null;
  if (!dir) return 'chromium';
  const sub = ['chrome-linux64', 'chrome-linux'].find((s) => fs.existsSync(path.join(base, dir, s, 'chrome')));
  return path.join(base, dir, sub || 'chrome-linux', 'chrome');
}

const page = (png, i) => `<!doctype html><meta charset="utf-8"><style>@page{size:A4;margin:0}html,body{margin:0;background:#fff}
img{width:210mm;display:block;transform:rotate(${(i % 2 ? 1 : -1) * (0.4 + (i % 3) * 0.2)}deg);filter:blur(0.35px) contrast(1.1) grayscale(1)}</style>
<img src="data:image/png;base64,${png.toString('base64')}">`;

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const jobs = [];
  for (const [i, [dir, prefix]] of PICK.entries()) {
    const f = fs.readdirSync(path.join(ROOT, dir)).find((x) => x.startsWith(prefix) && x.endsWith('.pdf'));
    const parser = new PDFParse({ data: new Uint8Array(fs.readFileSync(path.join(ROOT, dir, f))) });
    const shot = await parser.getScreenshot({ scale: 200 / 72, imageDataUrl: false });
    await parser.destroy();
    jobs.push({ html: page(Buffer.from(shot.pages[0].data), i), file: path.join(OUT, `스캔_${f}`) });
    if (i === 0) fs.writeFileSync(path.join(OUT, `사진_${f.replace('.pdf', '.png')}`), Buffer.from(shot.pages[0].data));
  }
  let pw = null;
  try { pw = require(process.env.TG_PLAYWRIGHT || 'playwright-core'); } catch { pw = null; }
  if (pw) {
    const b = await pw.chromium.launch({ executablePath: chromiumPath() });
    const pg = await b.newPage();
    for (const j of jobs) { await pg.setContent(j.html, { waitUntil: 'load' }); await pg.pdf({ path: j.file, format: 'A4', printBackground: true }); }
    await b.close();
  } else {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tgscan-'));
    jobs.forEach((j, k) => {
      const h = path.join(tmp, `${k}.html`);
      fs.writeFileSync(h, j.html);
      execFileSync(chromiumPath(), ['--headless', '--no-sandbox', '--disable-gpu', `--print-to-pdf=${j.file}`, '--no-pdf-header-footer', `file://${h}`], { stdio: 'ignore', timeout: 60000 });
    });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`스캔본 생성 완료: ${path.relative(process.cwd(), OUT)} (${fs.readdirSync(OUT).length}개)`);
})();
