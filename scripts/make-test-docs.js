'use strict';
// TEST 문서 세트 생성: node scripts/make-test-docs.js  →  test-docs/
//  TEST-01~10 공사 기준으로 종류별 10개씩(계약서, 산재보험 가입증명서, 기술지도 계약서, 결과보고서,
//  변경계약서, 산재보험 갱신, 납품연기원, 기술지도 추가계약서) + 단가계약 월별 정산실적 10개 + 담당자 일괄등록 양식
//  ※ 모든 업체·기관·인물·번호는 가상이며, 문서마다 'TEST용 가상 문서' 표시를 넣는다.
//  PDF 변환: Chromium 필요(환경변수 CHROMIUM_PATH 또는 기본 경로). playwright-core 가 있으면 더 빠르게 변환한다.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const JSZip = require('jszip');
const ExcelJS = require('exceljs');

const OUT = path.join(__dirname, '..', 'test-docs');
const OWNER = '가상석유화학(주) 울산공장'; // 발주자(갑) — 실제 회사가 아닌 가상 명칭
const won = (n) => n.toLocaleString('ko-KR');
const KNUM = ['', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구'];
function korAmount(n) { // 120000000 → 일억이천만
  const eok = Math.floor(n / 1e8), man = Math.floor((n % 1e8) / 1e4);
  const four = (x) => { const d = [Math.floor(x / 1000), Math.floor(x / 100) % 10, Math.floor(x / 10) % 10, x % 10]; return ['천', '백', '십', ''].map((u, i) => (d[i] ? (d[i] === 1 && u ? '' : KNUM[d[i]]) + u : '')).join(''); };
  return `${eok ? `${four(eok)}억` : ''}${man ? `${four(man)}만` : ''}`;
}
const dot = (d) => { const [y, m, dd] = d.split('-'); return `${y}. ${+m}. ${+dd}.`; };
const kor = (d) => { const [y, m, dd] = d.split('-'); return `${y}년 ${+m}월 ${+dd}일`; };
const addMonths = (d, n) => { const x = new Date(`${d}T00:00:00Z`); const day = x.getUTCDate(); x.setUTCDate(1); x.setUTCMonth(x.getUTCMonth() + n); const last = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate(); x.setUTCDate(Math.min(day, last)); return x.toISOString().slice(0, 10); };
const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const visits = (s, e) => Math.max(1, Math.ceil((Math.round((Date.parse(e) - Date.parse(s)) / 864e5) + 1) / 15));

const AG = {
  ag1: { name: '한국재해예방기술원 울산센터', person: '강지도' },
  ag2: { name: '동남건설안전기술지도원', person: '윤지도' },
  isk: { name: '산업안전관리', person: '신지도' },
};

// 10개 TEST 공사 — 판정 결과·추출 표기가 서로 다르게 구성
const P = [
  { no: 'TC-2026-001', type: 'G', name: 'NCC 분해로(F-101) 튜브 교체공사', co: '가람플랜트(주)', ceo: '김대표', boss: '김가람', dept: '정비팀', start: '2026-11-16', end: '2027-02-15', amt: 280000000, fmt: 'pdf', style: 'standard', ag: 'ag1', tgDate: '2026-11-12', tgStart: '2026-11-16', expect: '기술지도 대상 (기간 3개월, 2.8억)' },
  { no: 'TC-2026-002', type: 'G', name: 'PP공장 배관 보온 보수공사', co: '누리기전(주)', ceo: '이대표', boss: '이누리', dept: '정비팀', start: '2026-11-16', end: '2027-01-15', amt: 85000000, fmt: 'docx', style: 'dash', ag: 'ag1', tgDate: '2026-11-12', tgStart: '2026-11-16', expect: '대상 아님 (금액 1억 미만) → 금액 수정 시 대상 전환 TEST' },
  { no: 'TC-2026-003', type: 'G', name: '냉각탑 Fan 교체공사', co: '다솜산업개발(주)', ceo: '박대표', boss: '박다솜', dept: '설비팀', start: '2026-11-20', end: '2026-12-10', amt: 150000000, fmt: 'pdf', style: 'korean', ag: 'ag1', tgDate: '2026-11-18', tgStart: '2026-11-20', expect: '대상 아님 (공사기간 1개월 미만)' },
  { no: 'TC-2026-004', type: 'G', name: 'PE공장 반응기(R-201) 정비공사', co: '라온엔지니어링(주)', ceo: '최대표', boss: '최라온', dept: '생산팀(PE)', start: '2026-11-10', end: '2027-03-31', amt: 520000000, fmt: 'pdf', style: 'table', ag: 'ag1', tgDate: '2026-11-06', tgStart: '2026-11-10', expect: '기술지도 대상 (착공일/준공예정일 표 형식)' },
  { no: 'TC-2026-005', type: 'G', name: 'VCM 저장탱크(T-305) 도장공사', co: '마루건설(주)', ceo: '정대표', boss: '정마루', dept: '생산팀(VCM)', start: '2026-11-23', end: '2027-01-31', amt: 120000000, fmt: 'docx', style: 'short', ag: 'ag2', tgDate: '2026-11-20', tgStart: '2026-11-23', expect: '기술지도 대상 (한글 금액, 2자리 연도)' },
  { no: 'TC-2026-006', type: 'U', name: '[단가계약] 2026년 계전설비 정비 단가공사', co: '바름계전(주)', ceo: '한대표', boss: '한바름', dept: '계전팀', start: '2026-01-01', end: '2026-12-31', amt: 240000000, fmt: 'pdf', style: 'unit', ag: 'isk', tgDate: '2026-11-10', tgStart: '2026-11-16', monthly: 20000000, expect: '기술지도 대상 (단가 계약금액 1억 이상)' },
  { no: 'TC-2026-007', type: 'U', name: '[단가계약] 2026년 PVC1 보온·도장 단가공사', co: '새솔보온(주)', ceo: '오대표', boss: '오새솔', dept: '생산팀(PVC1)', start: '2026-01-01', end: '2026-12-31', amt: 90000000, fmt: 'pdf', style: 'unit', ag: 'isk', tgDate: '2026-11-20', tgStart: '2026-11-23', monthly: 11000000, expect: '누계 관리 → 10월 정산실적 Upload 시 누계 1.1억 → 대상 전환' },
  { no: 'TC-2026-008', type: 'U', name: '[단가계약] 2026년 PVC2 소모품 교체 단가공사', co: '아라정비(주)', ceo: '윤대표', boss: '윤아라', dept: '생산팀(PVC2)', start: '2026-01-01', end: '2026-12-31', amt: 60000000, fmt: 'docx', style: 'unit', ag: 'isk', tgDate: '2026-11-20', tgStart: '2026-11-23', monthly: 3000000, expect: '누계 관리 (누계 3천만원, 여유)' },
  { no: 'TC-2026-009', type: 'U', name: '[단가계약] 2026년 가소제공장 배관정비 단가공사', co: '자람기술(주)', ceo: '장대표', boss: '장자람', dept: '생산팀(가소제)', start: '2026-01-02', end: '2026-12-31', amt: 95000000, fmt: 'pdf', style: 'fromContract', ag: 'isk', tgDate: '2026-11-25', tgStart: '2026-12-01', monthly: 8500000, expect: '누계 관리 + 주의 (누계 85%, 연말 1억 초과 예상)' },
  { no: 'TC-2026-010', type: 'G', name: '설비동 지붕 방수공사', co: '하늬설비(주)', ceo: '임대표', boss: '임하늬', dept: '설비팀', start: '2026-12-01', end: '2026-12-31', amt: 100000000, fmt: 'pdf', style: 'compact', ag: 'ag2', tgDate: '2026-11-27', tgStart: '2026-12-01', expect: '기술지도 대상 (경계값: 정확히 1개월·1억원)' },
];
P.forEach((p, i) => {
  p.id = `TEST-${String(i + 1).padStart(2, '0')}`;
  p.bizNo = `000-00-1${String(i + 1).padStart(4, '0')}`;
  p.phone = `010-7000-${String(1001 + i).padStart(4, '0')}`;
  p.email = `test${String(i + 1).padStart(2, '0')}@example.com`;
  p.insNo = `TEST-${String(i + 1).padStart(3, '0')}-0000-${String(5000 + i)}`;
  p.newEnd = p.type === 'U' ? '2027-03-31' : addMonths(p.end, 2);
  p.newAmt = Math.round(p.amt * 1.2 / 1e6) * 1e6;
  p.tgEnd = p.type === 'U' ? p.end : p.end;
  p.tgCount = visits(p.tgStart, p.tgEnd);
  p.addCount = visits(addDays(p.tgEnd, 1), p.newEnd);
});

const NOTICE = '※ 시스템 TEST용 가상 문서입니다. 실제 계약서·증명서가 아니며 법적 효력이 없습니다.';
const short = (s) => s.replace(/\(주\)/g, '').replace(/[\\/:*?"<>|\s]/g, '');

// ───────── 문서 본문(줄 단위) ─────────
function contractLines(p) {
  const head = [p.type === 'U' ? '연 간 단 가 계 약 서' : '공 사 도 급 계 약 서', '', `계약번호 : ${p.no}`];
  const sign = ['', '발주자와 수급인은 상호 대등한 입장에서 위 공사에 대한 계약을 체결하고 신의에 따라 성실히 계약상의 의무를 이행한다.', '',
    `발 주 자 (갑) : ${OWNER}`, `수 급 인 (을) : 상호 : ${p.co}   대표이사 : ${p.ceo} (인)`, `사업자등록번호 : ${p.bizNo}`];
  const amtWon = `일금 ${korAmount(p.amt)}원정 (₩${won(p.amt)}, 부가가치세 포함)`;
  switch (p.style) {
    case 'standard': return [...head, `1. 공 사 명 : ${p.name}`, '2. 공사장소 : 울산공장 NCC 지역', `3. 계약기간 : ${dot(p.start)} ~ ${dot(p.end)}`, `4. 계약금액 : ${amtWon}`, '5. 지체상금률 : 0.1%', ...sign];
    case 'dash': return [...head, `공사명: ${p.name}`, `공사기간: ${p.start} ~ ${p.end}`, `도급금액: ${won(p.amt)}원 (부가세 포함)`, '하자담보책임기간: 1년', ...sign];
    case 'korean': return [...head, `공 사 명 : ${p.name}`, `공 사 기 간 : ${kor(p.start)} ~ ${kor(p.end)}`, `계 약 금 액 : 금 ${won(p.amt)}원`, ...sign];
    case 'short': return [...head, `건명 : ${p.name}`, `공사기간 : ${p.start.slice(2).replace(/-/g, '.')} ~ ${p.end.slice(2).replace(/-/g, '.')}`, `계약금액 : 일금 ${korAmount(p.amt)}원정`, ...sign];
    case 'compact': return [...head, `공사명 : ${p.name}`, `작업기간 : ${p.start.replace(/-/g, '')} ~ ${p.end.replace(/-/g, '')}`, `계약금액 : ${won(p.amt)}원`, ...sign];
    case 'unit': return [...head, `계약명 : ${p.name}`, `계약상대자 : ${p.co}`, `계약기간 : ${p.start.replace(/-/g, '.')} ~ ${p.end.replace(/-/g, '.')}`, `계약금액 : 금 ${won(p.amt)}원 (부가세 별도, 연간 추정금액)`, '', '본 계약은 단가계약으로서 발주자의 작업지시에 따라 계약단가로 정산한다.', '정산은 매월 말 작업실적에 따라 실시한다.', '', `발주자(갑) : ${OWNER}`];
    case 'fromContract': return [...head, `계약명 : ${p.name}`, `계약일자 : ${kor(p.start)}`, `계약기간 : 계약일로부터 ${kor(p.end)}까지`, `계약금액 : 금 ${won(p.amt)}원 (연간 추정금액)`, '', '본 계약은 단가계약으로서 작업지시서에 따라 계약단가로 정산한다.', '', `발주자(갑) : ${OWNER}`, `수급인(을) : ${p.co}  대표 ${p.ceo}`];
    default: return [];
  }
}

const docs = {
  insurance: (p, renew) => [
    renew ? '산재보험 가입증명원 (갱신)' : '산재보험 가입증명원', '', `관리번호 : ${p.insNo}`, `사업장명 : ${p.co}`, `대 표 자 : ${p.ceo}`, `사업자등록번호 : ${p.bizNo}`,
    `공 사 명 : ${p.name}`, `공사기간 : ${dot(p.start)} ~ ${dot(renew ? p.newEnd : p.end)}`, `보험관계 성립일 : ${dot(p.start)}`, `증명 용도 : 재해예방 기술지도 제출용`, '',
    '위 사업장이 산업재해보상보험에 가입되어 있음을 증명합니다. (TEST)', '', `발급일 : ${dot(renew ? '2026-12-20' : '2026-11-10')}`, '발급기관 : (TEST용 가상 발급기관)'],
  tgContract: (p) => {
    const a = AG[p.ag];
    const per = p.tgStart === p.start ? `${dot(p.tgStart)} ~ ${dot(p.tgEnd)}` : `${kor(p.tgStart)} ~ ${kor(p.tgEnd)}`;
    return ['재해예방 기술지도 계약서', '', `공 사 명 : ${p.name}`, `계약번호(공사) : ${p.no}`, `건설공사 발주자 : ${OWNER}`, `건설공사 시공자 : ${p.co}`, `기술지도기관 : ${a.name}`,
      `계약일자 : ${kor(p.tgDate)}`, `기술지도 기간 : ${per}`, `기술지도 횟수 : 총 ${p.tgCount}회 (15일에 1회 이상)`, `기술지도 대가 : 금 ${won(p.tgCount * 270000)}원 (부가세 별도)`, '',
      '위 건설공사에 대하여 산업안전보건법 제73조에 따른 재해예방 기술지도 계약을 체결한다.', '', `기술지도기관 : ${a.name}  지도요원 ${a.person} (인)`, `시공자 : ${p.co}  대표 ${p.ceo} (인)`];
  },
  result: (p) => {
    const a = AG[p.ag];
    const d = addDays(p.tgStart, 3);
    return ['재해예방 기술지도 결과보고서 (1회차)', '', `공 사 명 : ${p.name}`, `시 공 자 : ${p.co}`, `지도일자 : ${dot(d)} 10:00 ~ 12:00`, `지도기관 / 지도요원 : ${a.name} / ${a.person}`, '공 정 률 : 약 10%',
      '주요 위험작업 : 고소작업(비계), 화기작업, 중량물 양중', '', '[지적사항 및 개선요구]', '1. 비계 작업발판 안전난간(중간난간) 일부 미설치 → 즉시 설치', '2. 화기작업 시 소화기·감시인 배치 확인 필요', '3. 양중작업 신호수 지정 및 작업반경 출입통제 강화', '',
      '[종합 의견] 위 지적사항 보완 후 작업할 것을 권고함. (TEST)', '', `작성일 : ${dot(d)}   작성자 : ${a.person}`];
  },
  change: (p) => ['변 경 계 약 서', '', `계약번호 : ${p.no}-C1`, `원 계약명 : ${p.name}`, `계약상대자 : ${p.co}`, `변경 전 계약기간 : ${dot(p.start)} ~ ${dot(p.end)}`, `변경 후 계약기간 : ${dot(p.start)} ~ ${dot(p.newEnd)}`,
    `변경 전 계약금액 : ${won(p.amt)}원`, `변경 후 계약금액 : ${won(p.newAmt)}원`, `변경 사유 : ${p.type === 'U' ? '단가계약 계약기간 연장(후속 계약 체결 전까지)' : '설계변경에 따른 공사기간 연장'}`, '', `발주자(갑) : ${OWNER}`, `수급인(을) : ${p.co}  대표 ${p.ceo}`, `변경계약일 : ${dot(addDays(p.end, -20))}`],
  delay: (p) => ['납 품 (준공) 연 기 원', '', `공 사 명 : ${p.name}`, `계약번호 : ${p.no}`, `당초 준공(납품)기한 : ${dot(p.end)}`, `연기 요청 기한 : ${dot(p.newEnd)}`, '연기 사유 : 설계변경 및 자재 납기 지연으로 공정 지연', '', '위와 같이 준공(납품) 기한 연기를 요청합니다. (TEST)', '', `신청일 : ${dot(addDays(p.end, -25))}`, `신청인 : ${p.co}  대표 ${p.ceo} (인)`, `수신 : ${OWNER}`],
  addContract: (p) => {
    const a = AG[p.ag];
    return ['재해예방 기술지도 추가(변경) 계약서', '', `공 사 명 : ${p.name}`, `원 기술지도 계약일자 : ${kor(p.tgDate)}`, `계약일자 : ${kor(addDays(p.end, -10))}`, `변경 전 기술지도 기간 : ${dot(p.tgStart)} ~ ${dot(p.tgEnd)}`,
      `기술지도 기간 : ${dot(p.tgStart)} ~ ${dot(p.newEnd)}`, `추가 기술지도 횟수 : ${p.addCount}회 (총 ${p.tgCount + p.addCount}회)`, '', '공사기간 연장에 따라 재해예방 기술지도 기간을 위와 같이 연장한다. (TEST)', '', `기술지도기관 : ${a.name} (인)`, `시공자 : ${p.co} (인)`];
  },
};

// ───────── 파일 생성 ─────────
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function html(lines, p, { table = false } = {}) {
  let body;
  if (table) {
    // 표 형식(TEST-04): 라벨 칸 | 값 칸
    const rows = [['공사명', p.name], ['계약번호', p.no], ['발주자', OWNER], ['업체명', `${p.co} (대표 ${p.ceo})`], ['착공일', dot(p.start)], ['준공예정일', dot(p.end)], ['계약금액', `₩${won(p.amt)} (부가세 포함)`], ['공사장소', '울산공장 PE 지역']];
    body = `<h1>공 사 도 급 계 약 서</h1><table>${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table>
      <p>발주자와 수급인은 위 공사에 대하여 도급계약을 체결한다.</p><p>발 주 자 (갑) : ${esc(OWNER)}</p><p>수 급 인 (을) : ${esc(p.co)} 대표이사 ${esc(p.ceo)} (인)</p>`;
  } else {
    body = `<h1>${esc(lines[0])}</h1>${lines.slice(1).map((l) => (l ? `<p>${esc(l)}</p>` : '<p class="sp">&nbsp;</p>')).join('')}`;
  }
  return `<!doctype html><meta charset="utf-8"><style>
    @page { size: A4; margin: 18mm 18mm; }
    body { font-family: 'Malgun Gothic','WenQuanYi Zen Hei','Noto Sans KR',sans-serif; font-size: 13px; color: #222; position: relative; }
    .notice { border: 1px solid #c33; color: #c33; padding: 6px 10px; font-size: 11px; margin-bottom: 18px; }
    h1 { text-align: center; font-size: 22px; letter-spacing: 2px; margin: 10px 0 24px; }
    p { margin: 6px 0; line-height: 1.6; } p.sp { margin: 2px 0; }
    table { border-collapse: collapse; width: 100%; margin: 10px 0 18px; } th, td { border: 1px solid #888; padding: 8px 10px; text-align: left; } th { width: 28%; background: #f2f2f2; }
    .wm { position: fixed; top: 42%; left: 8%; font-size: 90px; color: rgba(200,0,0,.07); transform: rotate(-28deg); font-weight: 700; }
    .foot { margin-top: 30px; font-size: 11px; color: #888; border-top: 1px solid #ddd; padding-top: 6px; }
  </style><div class="wm">TEST</div><div class="notice">${esc(NOTICE)}</div>${body}<div class="foot">${esc(p.id)} · ${esc(p.no)} · 재해예방 기술지도 관리시스템 TEST 문서</div>`;
}

async function docx(lines, file) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  const para = (t, bold) => `<w:p><w:r>${bold ? '<w:rPr><w:b/><w:sz w:val="32"/></w:rPr>' : ''}<w:t xml:space="preserve">${esc(t)}</w:t></w:r></w:p>`;
  const body = [para(NOTICE), para(lines[0], true), ...lines.slice(1).map((l) => para(l))].join('');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`);
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));
}

function chromiumPath() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const base = '/opt/pw-browsers';
  const dir = fs.existsSync(base) ? fs.readdirSync(base).find((d) => /^chromium-\d+$/.test(d)) : null;
  return dir ? path.join(base, dir, 'chrome-linux', 'chrome') : 'chromium';
}

async function makePdfs(jobs) {
  let pw = null;
  try { pw = require(process.env.TG_PLAYWRIGHT || 'playwright-core'); } catch { pw = null; }
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'tgdocs-'));
  if (pw) {
    const b = await pw.chromium.launch({ executablePath: chromiumPath() });
    const pg = await b.newPage();
    for (const j of jobs) {
      await pg.setContent(j.html, { waitUntil: 'load' });
      await pg.pdf({ path: j.file, format: 'A4', printBackground: true });
    }
    await b.close();
  } else {
    jobs.forEach((j, i) => {
      const h = path.join(tmp, `${i}.html`);
      fs.writeFileSync(h, j.html);
      execFileSync(chromiumPath(), ['--headless', '--no-sandbox', '--disable-gpu', `--print-to-pdf=${j.file}`, '--no-pdf-header-footer', `file://${h}`], { stdio: 'ignore', timeout: 60000 });
    });
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

async function settlementFiles(dir) {
  for (let m = 1; m <= 10; m++) {
    const month = `2026-${String(m).padStart(2, '0')}`;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('월별정산실적');
    ws.columns = [{ header: '계약번호', width: 14 }, { header: '공사계약명', width: 44 }, { header: '업체명', width: 16 }, { header: '정산월', width: 10 }, { header: '정산금액', width: 14 }];
    ws.getRow(1).font = { bold: true };
    for (const p of P.filter((x) => x.type === 'U')) ws.addRow([p.no, p.name, p.co, month, p.monthly]);
    ws.getColumn(5).numFmt = '#,##0';
    await wb.xlsx.writeFile(path.join(dir, `단가계약_정산실적_${month}.xlsx`));
  }
}

async function usersFile(dir) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('담당자');
  ws.columns = ['역할', '소속', '이름', '직책', '이메일', '휴대폰'].map((h) => ({ header: h, width: h === '소속' ? 28 : 18 }));
  ws.getRow(1).font = { bold: true };
  for (const p of P) ws.addRow(['협력업체', p.co, p.boss, '현장소장', p.email, p.phone]);
  ws.addRow(['협력업체 관리부서', '생산팀(PVC1)', '구생산', '생산팀(PVC1) 공사담당', 'pvc1@example.com', '010-7000-2001']);
  ws.addRow(['협력업체 관리부서', '생산팀(PVC2)', '서생산', '생산팀(PVC2) 공사담당', 'pvc2@example.com', '010-7000-2002']);
  ws.addRow(['협력업체 관리부서', '생산팀(가소제)', '백생산', '생산팀(가소제) 공사담당', 'plast@example.com', '010-7000-2003']);
  await wb.xlsx.writeFile(path.join(dir, '담당자_TEST_일괄등록.xlsx'));
}

function readme() {
  const rows = P.map((p) => `| ${p.id} | ${p.type === 'U' ? '단가계약' : '일반'} | ${p.name} | ${p.co} | ${p.dept} | ${p.start} ~ ${p.end} | ${won(p.amt)} | ${AG[p.ag].name} | ${p.expect} |`).join('\n');
  return `# TEST 문서 세트 (재해예방 기술지도 관리시스템)

${NOTICE}
발주자(갑)는 가상의 '${OWNER}'입니다. 다시 만들기: \`node scripts/make-test-docs.js\`

## TEST 공사 10건

| 공사 | 구분 | 공사계약명 | 협력업체 | 협력업체 관리부서 | 계약기간 | 계약금액(원) | 기술지도기관 | 기대 결과 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
${rows}

## 폴더 구성 (종류별 10개)

| 폴더 | 사용 단계 | 사용자(역할) |
| --- | --- | --- |
| 01_공사계약서 | 신규 공사 등록(계약서 Upload → 자동 추출) | 구매부서 |
| 02_산재보험가입증명서 | 기술지도 서류 제출 | 협력업체 |
| 03_기술지도계약서 | 기술지도 계약서 제출 → 기술지도 개시(자동 추출) | 기술지도기관 |
| 04_기술지도결과보고서 | 기술지도 결과보고서 제출 | 기술지도기관 |
| 05_변경계약서_연장 | 연장 ① 계약서 갱신 | 구매부서 |
| 06_산재보험가입증명서_갱신_연장 | 연장 ② 관련서류 제출 | 협력업체 |
| 07_납품연기원_연장 | 연장 ② 관련서류 제출(해당 시) | 협력업체 |
| 08_기술지도추가계약서_연장 | 연장 ③ 추가계약서 제출 | 기술지도기관 |
| 09_단가계약_월별정산실적 | 2026년 1~10월 정산실적 Upload(누계) | 구매부서·협력업체 관리부서 |
| 10_담당자_일괄등록 | TEST 협력업체 소장 10명 + PVC1·PVC2·가소제 담당 등록 | 시스템 관리자 |

## 문서별 핵심 값 (자동 추출 확인용)

| 공사 | 기술지도 계약일자 | 기술지도 기간 | 횟수 | 연장 후 종료일 | 변경 계약금액(원) | 추가 횟수 |
| --- | --- | --- | --- | --- | --- | --- |
${P.map((p) => `| ${p.id} | ${p.tgDate} | ${p.tgStart} ~ ${p.tgEnd} | ${p.tgCount}회 | ${p.newEnd} | ${won(p.newAmt)} | ${p.addCount}회 |`).join('\n')}

단가계약 월별 정산금액(원/월): ${P.filter((x) => x.type === 'U').map((p) => `${p.id} ${won(p.monthly)}`).join(' · ')}
`;
}

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  const dirs = ['01_공사계약서', '02_산재보험가입증명서', '03_기술지도계약서', '04_기술지도결과보고서', '05_변경계약서_연장', '06_산재보험가입증명서_갱신_연장', '07_납품연기원_연장', '08_기술지도추가계약서_연장', '09_단가계약_월별정산실적', '10_담당자_일괄등록'];
  for (const d of dirs) fs.mkdirSync(path.join(OUT, d), { recursive: true });
  const D = (i) => path.join(OUT, dirs[i]);
  const jobs = [];
  for (const p of P) {
    const base = `${p.id}_${short(p.co)}`;
    const cl = contractLines(p);
    if (p.fmt === 'docx') await docx(cl, path.join(D(0), `${base}_공사계약서.docx`));
    else jobs.push({ file: path.join(D(0), `${base}_공사계약서.pdf`), html: html(cl, p, { table: p.style === 'table' }) });
    jobs.push({ file: path.join(D(1), `${base}_산재보험가입증명서.pdf`), html: html(docs.insurance(p, false), p) });
    jobs.push({ file: path.join(D(2), `${base}_기술지도계약서.pdf`), html: html(docs.tgContract(p), p) });
    jobs.push({ file: path.join(D(3), `${base}_기술지도결과보고서_1회차.pdf`), html: html(docs.result(p), p) });
    jobs.push({ file: path.join(D(4), `${base}_변경계약서.pdf`), html: html(docs.change(p), p) });
    jobs.push({ file: path.join(D(5), `${base}_산재보험가입증명서_갱신.pdf`), html: html(docs.insurance(p, true), p) });
    jobs.push({ file: path.join(D(6), `${base}_납품연기원.pdf`), html: html(docs.delay(p), p) });
    jobs.push({ file: path.join(D(7), `${base}_기술지도추가계약서.pdf`), html: html(docs.addContract(p), p) });
  }
  await makePdfs(jobs);
  await settlementFiles(D(8));
  await usersFile(D(9));
  fs.writeFileSync(path.join(OUT, 'README.md'), readme());
  const count = dirs.map((d) => fs.readdirSync(path.join(OUT, d)).length);
  console.log(`TEST 문서 생성 완료: ${path.relative(process.cwd(), OUT)}  (${dirs.map((d, i) => `${d.slice(3)} ${count[i]}`).join(', ')})`);
})();
