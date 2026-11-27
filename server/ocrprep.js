'use strict';
// OCR 전처리(서버·브라우저 공용): 표의 가로·세로 테두리선을 지운다(나머지는 원래 명암 유지).
// 표 테두리가 남아 있으면 OCR 엔진이 칸 안의 글자를 놓치는 경우가 많다.
// 이진화(흑백)는 흐린 스캔에서 오히려 인식률을 떨어뜨려 기본으로 쓰지 않는다.
// (TEST 문서 스캔본 34개 평가, 필드 정답 수: 선 제거만 74·64 / 전처리 없음 70·64 / 이진화+선 제거 71·42 — 보통·흐린 스캔 순)
// 입력/출력: { data: RGBA 배열(Uint8ClampedArray), width, height } — 캔버스 ImageData와 같은 모양

function otsu(gray) {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, t = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; t = i; }
  }
  return t;
}

function preprocess(img, { removeLines = true, binarize = false } = {}) {
  const { data, width: w, height: h } = img;
  const n = w * h;
  const gray = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) gray[i] = (data[j] * 299 + data[j + 1] * 587 + data[j + 2] * 114) / 1000;
  const t = otsu(gray);
  const ink = new Uint8Array(n);
  for (let i = 0; i < n; i++) ink[i] = gray[i] <= t ? 1 : 0;

  if (removeLines) {
    // 글자 획보다 훨씬 긴 직선만 지운다(가로: 폭의 15% 이상, 세로: 높이의 4% 이상)
    const minH = Math.max(80, Math.round(w * 0.15));
    const minV = Math.max(80, Math.round(h * 0.04));
    const kill = new Uint8Array(n);
    for (let y = 0; y < h; y++) {
      let x = 0;
      while (x < w) {
        if (!ink[y * w + x]) { x++; continue; }
        let e = x;
        while (e < w && ink[y * w + e]) e++;
        if (e - x >= minH) for (let k = x; k < e; k++) kill[y * w + k] = 1;
        x = e;
      }
    }
    for (let x = 0; x < w; x++) {
      let y = 0;
      while (y < h) {
        if (!ink[y * w + x]) { y++; continue; }
        let e = y;
        while (e < h && ink[e * w + x]) e++;
        if (e - y >= minV) for (let k = y; k < e; k++) kill[k * w + x] = 1;
        y = e;
      }
    }
    // 선 가장자리(번진 회색)까지 지우도록 1픽셀 넓힌다
    const wide = new Uint8Array(n);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (kill[i] || (x > 0 && kill[i - 1]) || (x < w - 1 && kill[i + 1]) || (y > 0 && kill[i - w]) || (y < h - 1 && kill[i + w])) wide[i] = 1;
      }
    }
    for (let i = 0; i < n; i++) if (wide[i]) { ink[i] = 0; gray[i] = 255; }
  }

  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const v = binarize ? (ink[i] ? 0 : 255) : gray[i];
    out[j] = v; out[j + 1] = v; out[j + 2] = v; out[j + 3] = 255;
  }
  return { data: out, width: w, height: h };
}

module.exports = { preprocess, otsu };
