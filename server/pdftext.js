'use strict';
// 서버(Node)용 PDF 텍스트 추출. 브라우저 빌드에서는 web/ 의 pdf.js 구현으로 대체된다.
module.exports = async function pdfText(buf) {
  const { PDFParse } = require('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  try {
    const res = await parser.getText();
    return res.text || '';
  } finally {
    await parser.destroy().catch(() => {});
  }
};
