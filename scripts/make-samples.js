'use strict';
// 시연·테스트용 샘플 파일 생성: node scripts/make-samples.js
//  - samples/공사계약서_일반공사_샘플.docx / .txt
//  - samples/공사계약서_단가계약_샘플.pdf (Chromium 이 있으면 생성)
//  - samples/단가계약_월별정산실적_샘플.xlsx
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const JSZip = require('jszip');
const ExcelJS = require('exceljs');

const OUT = path.join(__dirname, '..', 'samples');
fs.mkdirSync(OUT, { recursive: true });
const year = new Date().getFullYear();

const GENERAL = [
  '공 사 도 급 계 약 서',
  '',
  '계약번호 : C-2026-0520',
  '1. 공 사 명 : 2공장 Cooling Water 배관 교체공사',
  '2. 공사장소 : 울산공장 2공장 CW 계통',
  `3. 계약기간 : ${year}년 11월 1일 ~ ${year + 1}년 1월 31일`,
  '4. 계약금액 : 일금 일억오천삼백만원정 (₩153,000,000, 부가가치세 포함)',
  '5. 지체상금률 : 0.1%',
  '',
  '발주자와 수급인은 상호 대등한 입장에서 위 공사에 대한 도급계약을 체결하고 신의에 따라 성실히 계약상의 의무를 이행한다.',
  '',
  '발 주 자 (갑) : ○○석유화학(주) 울산공장',
  '수 급 인 (을) : 상호 : 동해기전(주)   대표이사 : 홍길동 (인)',
];

const UNIT = [
  '연 간 단 가 계 약 서',
  '',
  '계약번호 : U-2026-0201',
  `계약명 : [단가계약] ${year}년 3공장 배관정비 단가공사`,
  '계약상대자 : 태화이엔지(주)',
  `계약기간 : ${year}.11.01 ~ ${year}.12.31`,
  '계약금액 : 금 85,000,000원 (부가세 별도)',
  '',
  '본 계약은 단가계약으로서 발주자의 작업지시에 따라 계약단가로 정산한다.',
  '정산은 매월 말 작업실적에 따라 실시한다.',
];

function xmlEsc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

async function docx(lines, file) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  const body = lines.map((l) => `<w:p><w:r><w:t xml:space="preserve">${xmlEsc(l)}</w:t></w:r></w:p>`).join('');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`);
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));
}

function pdf(lines, file) {
  const candidates = [process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium', 'chromium', 'chromium-browser', 'google-chrome'].filter(Boolean);
  const html = path.join(OUT, '_tmp.html');
  fs.writeFileSync(html, `<!doctype html><meta charset="utf-8"><body style="font-family:'Malgun Gothic','WenQuanYi Zen Hei','Noto Sans KR',sans-serif;font-size:14px;padding:40px">${lines.map((l) => `<p>${xmlEsc(l) || '&nbsp;'}</p>`).join('')}</body>`);
  for (const bin of candidates) {
    let exe = bin;
    if (bin === '/opt/pw-browsers/chromium') {
      const dir = fs.existsSync('/opt/pw-browsers') ? fs.readdirSync('/opt/pw-browsers').find((d) => /^chromium-\d+$/.test(d)) : null;
      if (!dir) continue;
      exe = path.join('/opt/pw-browsers', dir, 'chrome-linux', 'chrome');
      if (!fs.existsSync(exe)) continue;
    }
    try {
      execFileSync(exe, ['--headless', '--no-sandbox', '--disable-gpu', `--print-to-pdf=${file}`, '--no-pdf-header-footer', `file://${html}`], { stdio: 'ignore', timeout: 60000 });
      fs.rmSync(html, { force: true });
      return true;
    } catch { /* 다음 후보 */ }
  }
  fs.rmSync(html, { force: true });
  return false;
}

async function settlementXlsx(file) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('월별정산실적');
  ws.addRow(['계약번호', '공사계약명', '업체명', '정산월', '정산금액']);
  // 시연 데이터 'U-2026-0102 계장정비 단가공사'(누계 약 83%)에 9월분 추가 → 1억원 초과로 대상 전환
  ws.addRow(['U-2026-0102', `[단가계약] ${year}년 2공장 계장정비 단가공사`, '한빛계전(주)', `${year}-${String(new Date().getMonth() + 1).padStart(2, '0')}`, 19500000]);
  ws.addRow(['U-2026-0104', `[단가계약] ${year}년 생산팀 소모품 교체 단가공사`, '동해기전(주)', `${year}-${String(new Date().getMonth() + 1).padStart(2, '0')}`, 2100000]);
  ws.getColumn(5).numFmt = '#,##0';
  await wb.xlsx.writeFile(file);
}

(async () => {
  fs.writeFileSync(path.join(OUT, '공사계약서_일반공사_샘플.txt'), GENERAL.join('\n'));
  await docx(GENERAL, path.join(OUT, '공사계약서_일반공사_샘플.docx'));
  await docx(UNIT, path.join(OUT, '공사계약서_단가계약_샘플.docx'));
  const ok = pdf(UNIT, path.join(OUT, '공사계약서_단가계약_샘플.pdf'));
  await settlementXlsx(path.join(OUT, '단가계약_월별정산실적_샘플.xlsx'));
  console.log('샘플 생성 완료:', fs.readdirSync(OUT).join(', '), ok ? '' : '(Chromium 없음: PDF 생략)');
})();
