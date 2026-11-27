'use strict';
// 브라우저용 OCR: 스캔 PDF·이미지를 이 브라우저 안에서 읽는다(문서를 외부 서비스로 보내지 않음).
//  - OCR 모델: Tesseract(LSTM) 한국어+영어 — 엔진·학습데이터는 페이지와 함께 배포된 ocr/ 폴더에서 불러온다
//  - PDF 페이지 → 캔버스: pdf.js / 전처리: server/ocrprep.js (서버와 같은 코드)
const { preprocess } = require('./ocrprep');

const MAX_PAGES = 5;
const SCALE = 3;
let workerP = null;

function cfg() { return (typeof window !== 'undefined' && window.__TG_OCR) || null; }
function enabled() { return !!cfg(); }
const abs = (rel) => new URL(rel, cfg().base || location.href).href;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('OCR 엔진을 불러오지 못했습니다.'));
    document.head.appendChild(s);
  });
}

async function worker() {
  if (!workerP) {
    workerP = (async () => {
      if (!window.Tesseract) await loadScript(abs('tesseract.min.js'));
      const w = await window.Tesseract.createWorker(['kor', 'eng'], 1, {
        workerPath: abs('worker.min.js'),
        workerBlobURL: false,
        corePath: abs('tesseract-core-simd-lstm.wasm.js'),
        langPath: abs('.').replace(/\/$/, ''),
        cacheMethod: 'none',
        gzip: true,
      });
      await w.setParameters({ preserve_interword_spaces: '1' });
      return w;
    })().catch((e) => { workerP = null; throw new Error(`OCR 엔진을 시작하지 못했습니다: ${e && e.message ? e.message : e}`); });
  }
  return workerP;
}

async function recognizeCanvas(canvas) {
  const ctx = canvas.getContext('2d');
  const out = preprocess(ctx.getImageData(0, 0, canvas.width, canvas.height));
  ctx.putImageData(new ImageData(out.data, out.width, out.height), 0, 0);
  const w = await worker();
  const { data } = await w.recognize(canvas);
  return { text: data.text || '', confidence: data.confidence };
}

function whiteCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.round(w);
  c.height = Math.round(h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  return c;
}

async function ocrPdf(buf) {
  if (!enabled()) throw new Error('이 화면에서는 OCR을 사용할 수 없습니다.');
  const L = window.pdfjsLib;
  if (!L) throw new Error('PDF 분석 기능을 불러오지 못했습니다.');
  const t0 = Date.now();
  const doc = await L.getDocument({ data: new Uint8Array(buf).slice(0), isEvalSupported: false }).promise;
  const n = Math.min(doc.numPages, MAX_PAGES);
  const texts = [];
  const confs = [];
  for (let i = 1; i <= n; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: SCALE });
    const c = whiteCanvas(vp.width, vp.height);
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    const r = await recognizeCanvas(c);
    texts.push(r.text);
    confs.push(r.confidence);
  }
  const total = doc.numPages;
  await doc.destroy();
  return { text: texts.join('\n'), pages: n, totalPages: total, confidence: avg(confs), ms: Date.now() - t0 };
}

async function ocrImage(buf) {
  if (!enabled()) throw new Error('이 화면에서는 OCR을 사용할 수 없습니다.');
  const t0 = Date.now();
  const bmp = await createImageBitmap(new Blob([buf]));
  const k = Math.min(3, Math.max(1, 2400 / Math.max(bmp.width, bmp.height)));
  const c = whiteCanvas(bmp.width * k, bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  const r = await recognizeCanvas(c);
  return { text: r.text, pages: 1, totalPages: 1, confidence: r.confidence, ms: Date.now() - t0 };
}

const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0);

module.exports = { ocrPdf, ocrImage, enabled };
