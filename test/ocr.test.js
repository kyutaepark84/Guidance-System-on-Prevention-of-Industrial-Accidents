'use strict';
// OCR: 오인식 보정 · 전처리(표 테두리 제거) · 스캔 이미지 실제 인식
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.TG_DATA_DIR = process.env.TG_DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'tg-ocr-'));
const x = require('../server/extract');
const { preprocess } = require('../server/ocrprep');

test('OCR 오인식 보정: 라벨 글자, 원→8', () => {
  const t = x.normalizeOcrText('계약금맥 : 금 240,000,0008 (부가세 별도)\n계약삼대자 : 바름계전(주)\n공사명 : 점비동 보수');
  assert.match(t, /계약금액 : 금 240,000,000원/);
  assert.match(t, /계약상대자 : 바름계전\(주\)/);
  assert.match(t, /공사명 : 점비동 보수/, '값(콜론 뒤)은 고치지 않음');
  const f = x.parseContractText(t).fields;
  assert.equal(f.amount, 240000000);
  assert.equal(f.companyName, '바름계전(주)');
});

test('OCR 오인식 보정: 정상 숫자는 그대로', () => {
  assert.equal(x.normalizeOcrText('금액 : 240,000,008 원'), '금액 : 240,000,008 원');
});

test('전처리: 표 가로·세로 테두리선 제거, 글자 획은 유지', () => {
  const w = 400, h = 300;
  const data = new Uint8ClampedArray(w * h * 4).fill(255);
  const dot = (x0, y0) => { const i = (y0 * w + x0) * 4; data[i] = data[i + 1] = data[i + 2] = 0; };
  for (let x0 = 10; x0 < 390; x0++) dot(x0, 50); // 가로 테두리
  for (let y0 = 20; y0 < 280; y0++) dot(200, y0); // 세로 테두리
  for (let y0 = 100; y0 < 120; y0++) dot(50, y0); // 글자 획(짧음)
  const out = preprocess({ data, width: w, height: h });
  const ink = (x0, y0) => out.data[(y0 * w + x0) * 4] === 0;
  assert.equal(ink(100, 50), false);
  assert.equal(ink(200, 150), false);
  assert.equal(ink(50, 110), true);
});

test('스캔 이미지 OCR → 계약 정보 추출 (TEST-06 계약서)', { skip: process.env.TG_OCR === '0' }, async () => {
  const { PDFParse } = require('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(fs.readFileSync(path.join(__dirname, '..', 'test-docs', '01_공사계약서', 'TEST-06_바름계전_공사계약서.pdf'))) });
  const shot = await parser.getScreenshot({ scale: 2, imageDataUrl: false });
  await parser.destroy();
  // 글자층 없는 이미지로 만들어 OCR 경로를 탄다
  const r = await x.analyzeContract(Buffer.from(shot.pages[0].data), 'scan.png', { ownerNames: [] });
  assert.ok(r.ocr, 'OCR 경로');
  assert.match(r.notice, /OCR/);
  assert.equal(r.fields.amount, 240000000);
  assert.equal(r.fields.startDate, '2026-01-01');
  assert.equal(r.fields.endDate, '2026-12-31');
  assert.equal(r.fields.companyName, '바름계전(주)');
  assert.equal(r.fields.type, 'UNIT_PRICE');
});

test.after(() => require('../server/ocr').shutdown());
