'use strict';
// 브라우저용 PDF 텍스트 추출 (pdf.js). 줄 단위로 재구성한다.
module.exports = async function pdfText(buf) {
  const L = typeof window !== 'undefined' && window.pdfjsLib;
  if (!L) throw new Error('PDF 분석 기능을 불러오지 못했습니다. 정보를 직접 입력해 주세요.');
  const doc = await L.getDocument({ data: buf, isEvalSupported: false }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const tc = await (await doc.getPage(i)).getTextContent();
    const lines = [];
    let line = '';
    let lastY = null;
    for (const it of tc.items) {
      const y = it.transform ? it.transform[5] : lastY;
      if (lastY !== null && Math.abs(y - lastY) > 2 && line) { lines.push(line); line = ''; }
      line += it.str || '';
      lastY = y;
      if (it.hasEOL) { lines.push(line); line = ''; lastY = null; }
    }
    if (line) lines.push(line);
    pages.push(lines.join('\n'));
  }
  await doc.destroy();
  return pages.join('\n');
};
