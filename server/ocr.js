'use strict';
// 서버(Node)용 OCR: 스캔 PDF·이미지에서 글자를 읽는다. (브라우저 빌드에서는 web/ocr.js로 대체)
//  - OCR 모델: Tesseract(LSTM) 한국어+영어 학습데이터 — 외부 서비스로 문서를 보내지 않고 이 서버에서 처리
//  - PDF 페이지 → 이미지: pdf-parse(getScreenshot) / 전처리: server/ocrprep.js
//  - 끄기: 환경변수 TG_OCR=0
const fs = require('fs');
const os = require('os');
const path = require('path');
const { preprocess } = require('./ocrprep');

const MAX_PAGES = Number(process.env.TG_OCR_MAX_PAGES) || 5; // 계약 정보는 앞쪽 몇 장에 있다
const SCALE = 3; // 약 216dpi로 렌더링
const IDLE_MS = 5 * 60 * 1000;

let workerP = null;
let idle = null;

function enabled() { return process.env.TG_OCR !== '0'; }

// 한국어·영어 학습데이터를 한 폴더에 모은다(tesseract는 langPath 하나만 받음)
function langDir() {
  const dir = path.join(process.env.TG_DATA_DIR || path.join(__dirname, '..', 'data'), 'ocr-lang');
  fs.mkdirSync(dir, { recursive: true });
  for (const lang of ['kor', 'eng']) {
    const dst = path.join(dir, `${lang}.traineddata.gz`);
    if (fs.existsSync(dst)) continue;
    const src = path.join(path.dirname(require.resolve(`@tesseract.js-data/${lang}/package.json`)), '4.0.0_best_int', `${lang}.traineddata.gz`);
    fs.copyFileSync(src, dst);
  }
  return dir;
}

async function worker() {
  if (!workerP) {
    const { createWorker } = require('tesseract.js');
    workerP = createWorker(['kor', 'eng'], 1, { langPath: langDir(), cacheMethod: 'none', gzip: true, cachePath: os.tmpdir() })
      .then(async (w) => { await w.setParameters({ preserve_interword_spaces: '1' }); return w; })
      .catch((e) => { workerP = null; throw e; });
  }
  clearTimeout(idle);
  idle = setTimeout(async () => { const p = workerP; workerP = null; if (p) (await p).terminate().catch(() => {}); }, IDLE_MS);
  if (idle.unref) idle.unref();
  return workerP;
}

// PNG → 전처리된 PNG
async function prepare(png) {
  const { createCanvas, loadImage } = require('@napi-rs/canvas');
  const im = await loadImage(Buffer.from(png));
  const c = createCanvas(im.width, im.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, im.width, im.height);
  ctx.drawImage(im, 0, 0);
  const out = preprocess(ctx.getImageData(0, 0, im.width, im.height));
  ctx.putImageData(new (require('@napi-rs/canvas').ImageData)(out.data, out.width, out.height), 0, 0);
  return c.toBuffer('image/png');
}

async function recognizePng(png) {
  const w = await worker();
  const { data } = await w.recognize(await prepare(png));
  return { text: data.text || '', confidence: data.confidence };
}

async function ocrPdf(buf) {
  if (!enabled()) throw new Error('OCR이 꺼져 있습니다(TG_OCR=0).');
  const t0 = Date.now();
  const { PDFParse } = require('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  let shots;
  try {
    shots = await parser.getScreenshot({ scale: SCALE, first: MAX_PAGES, imageDataUrl: false, imageBuffer: true });
  } finally {
    await parser.destroy().catch(() => {});
  }
  const texts = [];
  const confs = [];
  for (const pg of shots.pages) {
    const r = await recognizePng(pg.data);
    texts.push(r.text);
    confs.push(r.confidence);
  }
  return { text: texts.join('\n'), pages: shots.pages.length, totalPages: shots.total, confidence: avg(confs), ms: Date.now() - t0 };
}

async function ocrImage(buf) {
  if (!enabled()) throw new Error('OCR이 꺼져 있습니다(TG_OCR=0).');
  const t0 = Date.now();
  const { createCanvas, loadImage } = require('@napi-rs/canvas');
  const im = await loadImage(Buffer.from(buf));
  // 작은 사진은 키워서 읽는다(글자 높이 확보)
  const k = Math.min(3, Math.max(1, 2400 / Math.max(im.width, im.height)));
  const c = createCanvas(Math.round(im.width * k), Math.round(im.height * k));
  c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
  const r = await recognizePng(c.toBuffer('image/png'));
  return { text: r.text, pages: 1, totalPages: 1, confidence: r.confidence, ms: Date.now() - t0 };
}

// OCR 작업자 종료(테스트·서버 종료 시)
async function shutdown() {
  clearTimeout(idle);
  const p = workerP;
  workerP = null;
  if (p) await (await p).terminate().catch(() => {});
}

const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0);

module.exports = { ocrPdf, ocrImage, enabled, shutdown };
