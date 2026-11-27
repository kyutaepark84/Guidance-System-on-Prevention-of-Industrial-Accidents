'use strict';
// 공사 계약서 파일에서 텍스트를 뽑고, 공사계약명/업체명/계약기간/계약금액 등을 추출한다.
// DEMO 단계: 규칙(정규식) 기반. 추출 결과는 반드시 등록 화면에서 사람이 확인·수정 후 저장한다.
// 추후: 구매시스템/SAP 계약정보 연동 시 이 모듈을 연동 어댑터로 대체한다.
const path = require('path');
const JSZip = require('jszip');
const ExcelJS = require('exceljs');

// ───────────────────────── 텍스트 추출 ─────────────────────────

function decodeText(buf) {
  const utf8 = new TextDecoder('utf-8').decode(buf);
  if (!utf8.includes('\uFFFD')) return utf8.replace(/^\uFEFF/, '');
  try {
    return new TextDecoder('euc-kr').decode(buf); // 한글 윈도우(CP949) 텍스트
  } catch {
    return utf8;
  }
}

function xmlText(xml, paraTag, textTag) {
  return xml
    .replace(new RegExp(`</${paraTag}>`, 'g'), '\n')
    .replace(new RegExp(`<${textTag}(?:\\s[^>]*)?>([^<]*)</${textTag}>`, 'g'), '\u0001$1\u0002')
    .replace(/<[^>]+>/g, '')
    .replace(/\u0002\u0001/g, '')
    .replace(/[\u0001\u0002]/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

// PDF 텍스트 추출은 실행 환경별 구현(서버: pdf-parse / 브라우저: pdf.js)
const pdfText = (buf) => require('./pdftext')(buf);

async function docxText(buf) {
  const zip = await JSZip.loadAsync(buf);
  const f = zip.file('word/document.xml');
  if (!f) throw new Error('DOCX 본문(word/document.xml)을 찾을 수 없습니다.');
  return xmlText(await f.async('string'), 'w:p', 'w:t');
}

async function hwpxText(buf) {
  const zip = await JSZip.loadAsync(buf);
  const names = Object.keys(zip.files).filter((n) => /^Contents\/section\d+\.xml$/i.test(n)).sort();
  if (!names.length) throw new Error('HWPX 본문(Contents/section*.xml)을 찾을 수 없습니다.');
  const parts = [];
  for (const n of names) parts.push(xmlText(await zip.file(n).async('string'), 'hp:p', 'hp:t'));
  return parts.join('\n');
}

async function xlsxText(buf) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const lines = [];
  wb.eachSheet((ws) => {
    ws.eachRow((row) => {
      const cells = [];
      row.eachCell((c) => cells.push(cellText(c)));
      lines.push(cells.join(' '));
    });
  });
  return lines.join('\n');
}

function cellText(c) {
  const v = c.value;
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((t) => t.text).join('');
    if ('result' in v) return v.result instanceof Date ? v.result.toISOString().slice(0, 10) : String(v.result ?? '');
    if (v.text) return String(v.text);
  }
  return String(v);
}

async function extractText(buf, filename) {
  const ext = path.extname(filename || '').toLowerCase();
  switch (ext) {
    case '.pdf': return pdfText(buf);
    case '.docx': return docxText(buf);
    case '.hwpx': return hwpxText(buf);
    case '.xlsx': return xlsxText(buf);
    case '.txt': case '.csv': case '.md': return decodeText(buf);
    case '.jpg': case '.jpeg': case '.png': return ''; // 이미지는 OCR로 읽는다(extractTextInfo)
    case '.hwp':
      throw new Error('HWP(구버전 한글) 파일은 DEMO에서 자동 분석을 지원하지 않습니다. PDF 또는 HWPX로 저장 후 올리거나, 정보를 직접 입력해 주세요.');
    default:
      throw new Error(`지원하지 않는 파일 형식입니다(${ext || '확장자 없음'}). PDF, DOCX, HWPX, XLSX, TXT, JPG, PNG를 지원합니다.`);
  }
}

// ───────────────────────── 금액 파싱 ─────────────────────────

const KDIGIT = { 영: 0, 공: 0, 일: 1, 이: 2, 삼: 3, 사: 4, 오: 5, 육: 6, 칠: 7, 팔: 8, 구: 9 };
const KSMALL = { 십: 10, 백: 100, 천: 1000 };
const KBIG = { 만: 1e4, 억: 1e8, 조: 1e12 };

// "일억이천삼백만", "1억 2,000만", "120,000,000" 등을 숫자로 변환
function parseKoreanAmount(str) {
  const s = String(str).replace(/[\s,원정금₩\\]/g, '').replace(/^일금/, '');
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  let total = 0, section = 0, num = 0, any = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (/\d/.test(ch)) {
      let j = i;
      while (j < s.length && /[\d.]/.test(s[j])) j++;
      num = Number(s.slice(i, j));
      i = j - 1;
      any = true;
    } else if (ch in KDIGIT) {
      num = KDIGIT[ch];
      any = true;
    } else if (ch in KSMALL) {
      section += (num || 1) * KSMALL[ch];
      num = 0;
      any = true;
    } else if (ch in KBIG) {
      section += num;
      total += (section || 1) * KBIG[ch];
      section = 0;
      num = 0;
      any = true;
    } else {
      break; // 금액이 아닌 문자에서 멈춘다
    }
  }
  if (!any) return null;
  return Math.round(total + section + num);
}

// ───────────────────────── 날짜 파싱 ─────────────────────────
// 2026.01.01 / 2026-1-1 / 2026/01/01 / 2026년 1월 1일 / 2026. 1. 1. / '26.01.01 / 20260101
const DATE_RE = /(?:^|[^\d])((?:19|20)\d{2}|'?\d{2})\s*(?:[.\-/]|년)\s*(\d{1,2})\s*(?:[.\-/]|월)\s*(\d{1,2})(?!\d)\s*(?:일|\.)?|(?:^|[^\d])((?:19|20)\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?!\d)/g;

function normDate(y, m, d) {
  let yy = String(y).replace("'", '');
  if (yy.length === 2) yy = `20${yy}`;
  if (+m < 1 || +m > 12 || +d < 1 || +d > 31) return null;
  return `${yy}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function datesIn(str, { fourDigitOnly = false } = {}) {
  const out = [];
  let m;
  DATE_RE.lastIndex = 0;
  while ((m = DATE_RE.exec(String(str)))) {
    const d = m[1] ? ((fourDigitOnly && m[1].replace("'", '').length !== 4) ? null : normDate(m[1], m[2], m[3])) : normDate(m[4], m[5], m[6]);
    if (d) out.push(d);
    DATE_RE.lastIndex = Math.max(DATE_RE.lastIndex - 1, m.index + 1);
  }
  return out;
}

// ───────────────────────── 필드 추출 ─────────────────────────

const escRe = (c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const spaced = (label) => label.split('').map(escRe).join('\\s*');

function cleanValue(v) {
  return String(v || '')
    .replace(/^[\s:：\-|]+/, '')
    .replace(/[\s|]+$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// 라벨 다음에 오는 값(같은 줄)을 찾는다. 라벨 글자 사이 공백 허용("공 사 명")
// 1차: "라벨 : 값" 형태(콜론 필수) / 2차: 줄 맨 앞의 라벨(표 형태, 콜론 없음)
function labelMatches(lines, labels) {
  const out = [];
  for (const strict of [true, false]) {
    for (const label of labels) {
      const pat = spaced(label);
      const re = strict
        ? new RegExp(`(?:^|[\\s|①-⑳0-9.)(])${pat}\\s*(?:\\([^)]*\\))?\\s*[:：]\\s*(.*)$`)
        : new RegExp(`^\\s*(?:[①-⑳]|\\d+[.)])?\\s*${pat}\\s*(?:\\([^)]*\\))?\\s+(.+)$`);
      for (let i = 0; i < lines.length; i++) {
        const m = re.exec(lines[i]);
        if (!m) continue;
        let v = cleanValue(m[1]);
        if (!v && lines[i + 1]) v = cleanValue(lines[i + 1]); // 표에서 값이 다음 줄에 있는 경우
        if (v) out.push({ value: v, line: lines[i].trim(), index: i, label, strict });
      }
    }
  }
  return out;
}

function labelValue(lines, labels) {
  return labelMatches(lines, labels)[0] || null;
}

function findAmount(lines) {
  const labels = ['총계약금액', '계약금액', '공사금액', '도급금액', '계약총액', '총공사비', '연간계약금액', '추정계약금액'];
  for (const label of labels) {
    const pat = spaced(label);
    const re = new RegExp(pat);
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      const win = lines[i].slice(lines[i].search(re)) + ' ' + (lines[i + 1] || '');
      // 1순위: 숫자 표기(₩120,000,000 / 120,000,000원)
      const num = /(?:₩|\\|￦)\s*([\d,]{4,})|([\d,]{5,})\s*원/.exec(win);
      if (num) {
        const n = Number((num[1] || num[2]).replace(/,/g, ''));
        if (n > 0) return { value: n, line: lines[i].trim() };
      }
      // 2순위: 한글 표기(일금 일억이천만원정)
      const kor = /(?:일금|금)?\s*([영공일이삼사오육칠팔구십백천만억조\d,\s]+)\s*원/.exec(win.replace(new RegExp(pat), ''));
      if (kor) {
        const n = parseKoreanAmount(kor[1]);
        if (n && n >= 1000) return { value: n, line: lines[i].trim() };
      }
    }
  }
  return null;
}

const PERIOD_LABELS = ['계약기간', '공사기간', '이행기간', '용역기간', '작업기간', '수행기간', '공기', '납품기한', '계약유효기간'];
const START_LABELS = ['착공일자', '착공예정일', '착공일', '공사시작일', '계약시작일', '계약개시일', '시작일', '개시일'];
const END_LABELS = ['준공예정일자', '준공예정일', '준공일자', '준공일', '완공일', '공사종료일', '계약종료일', '계약만료일', '종료일', '만료일', '완료일'];
const CONTRACT_DATE_LABELS = ['계약일자', '계약체결일', '계약일', '체결일자', '체결일'];

function firstDateByLabels(lines, labels) {
  for (const label of labels) {
    const re = new RegExp(spaced(label));
    for (let i = 0; i < lines.length; i++) {
      const pos = lines[i].search(re);
      if (pos < 0) continue;
      const d = datesIn(lines[i].slice(pos) + ' ' + (lines[i + 1] || ''))[0];
      if (d) return { date: d, line: lines[i].trim() };
    }
  }
  return null;
}

// 라벨 줄과 그 다음 몇 줄(표가 줄바꿈된 PDF)을 함께 본다
function periodByLabels(lines, labels, contractDate) {
  for (const label of labels) {
    const re = new RegExp(spaced(label));
    for (let i = 0; i < lines.length; i++) {
      const pos = lines[i].search(re);
      if (pos < 0) continue;
      const own = lines[i].slice(pos);
      const fromContract = /계약\s*(?:체결)?\s*일\s*(?:로)?\s*부터|체결일\s*부터/.test(own);
      const ownDates = datesIn(own);
      if (ownDates.length >= 2 && ownDates[0] <= ownDates[1]) return { start: ownDates[0], end: ownDates[1], line: lines[i].trim() };
      // "계약일로부터 2026.12.31까지"
      if (fromContract && ownDates.length === 1 && contractDate) return { start: contractDate, end: ownDates[0], line: lines[i].trim() };
      if (fromContract) continue;
      const ds = datesIn([own, lines[i + 1] || '', lines[i + 2] || '', lines[i + 3] || ''].join(' '));
      if (ds.length >= 2 && ds[0] <= ds[1]) return { start: ds[0], end: ds[1], line: lines[i].trim() };
    }
  }
  return null;
}

function findPeriod(lines, contractDate) {
  const byLabel = periodByLabels(lines, PERIOD_LABELS, contractDate);
  if (byLabel) return byLabel;
  // 착공일/준공일 별도 기재
  const s = firstDateByLabels(lines, START_LABELS);
  const e = firstDateByLabels(lines, END_LABELS);
  if (s && e && s.date <= e.date) return { start: s.date, end: e.date, line: `${s.line} / ${e.line}` };
  // 라벨 없이 "날짜 ~ 날짜" 또는 "날짜부터 날짜까지"
  for (let i = 0; i < lines.length; i++) {
    const win = `${lines[i]} ${lines[i + 1] || ''}`;
    if (!/[~∼～〜]|부터|까지|-\s*\d{4}/.test(win)) continue;
    const ds = datesIn(win, { fourDigitOnly: true });
    if (ds.length >= 2 && ds[0] < ds[1]) return { start: ds[0], end: ds[1], line: lines[i].trim() };
  }
  return null;
}

function stripTrailingNoise(v) {
  return v.replace(/\s*(?:\(인\)|\(서명\)|\(날인\)|인$).*$/, '').trim();
}

const normCo = (s) => String(s || '').replace(/\(주\)|㈜|주식회사|\(유\)|유한회사|\s|[()]/g, '').toLowerCase();

// 발주자(우리 회사) 이름은 업체명 후보에서 제외한다
function isOwner(value, line, ownerNames) {
  const v = normCo(value);
  if (ownerNames.some((o) => o && v.includes(normCo(o)))) return true;
  return /발\s*주\s*(?:자|처|사|기관)|도\s*급\s*인|\(\s*갑\s*\)|^\s*갑\s*[:：]/.test(line);
}

function cleanCompany(v) {
  return stripTrailingNoise(String(v)
    .replace(/^(?:\(?을\)?\s*)?(?:상\s*호|업\s*체\s*명|회\s*사\s*명|법\s*인\s*명)\s*[:：]?\s*/, '')
    .replace(/\s*(?:대표이사|대표자|대표|사업자\s*등록\s*번호|사업자번호|주소|소재지|전화|TEL|성명).*$/i, '')
    .replace(/[,;]+$/, ''));
}

const COMPANY_LABELS = ['수급인', '수급자', '계약상대자', '계약상대방', '업체명', '공급자', '시공자', '시공사', '상호', '회사명', '협력업체', '법인명'];

function findCompany(lines, ownerNames) {
  const cands = [];
  // ① "(을)" 표기 블록: "(을) 상호: ○○(주)" / "을 : ○○(주)"
  for (let i = 0; i < lines.length; i++) {
    const m = /(?:^|\s|\()을\s*\)?\s*[:：]?\s*(.+)$/.exec(lines[i]);
    if (m && /\(\s*을\s*\)|^\s*을\s*[:：]/.test(lines[i])) {
      const v = cleanCompany(m[1]);
      if (v && v.length >= 2) cands.push({ value: v, line: lines[i].trim(), score: 3 });
      // 다음 줄에 상호가 오는 경우
      const next = lines[i + 1] && /상\s*호|업\s*체\s*명|회\s*사\s*명/.test(lines[i + 1]) ? cleanCompany(lines[i + 1]) : '';
      if (next) cands.push({ value: next, line: lines[i + 1].trim(), score: 3 });
    }
  }
  // ② 라벨
  for (const m of labelMatches(lines, COMPANY_LABELS)) {
    const v = cleanCompany(m.value);
    if (v && v.length >= 2) cands.push({ value: v, line: m.line, score: (m.strict ? 2 : 1) + (/수급|계약상대|을/.test(m.label) ? 1 : 0) });
  }
  // ③ 회사 형태 이름(○○(주), 주식회사 ○○)
  const re = /((?:\(주\)|㈜|주식회사)\s*[가-힣A-Za-z0-9&]+(?:\s*[가-힣A-Za-z0-9&]+)?|[가-힣A-Za-z0-9&]+\s*(?:\(주\)|㈜|주식회사))/g;
  lines.forEach((l) => {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(l))) cands.push({ value: m[1].trim(), line: l.trim(), score: 0 });
  });
  const ok = cands.filter((c) => !isOwner(c.value, c.line, ownerNames));
  ok.sort((a, b) => b.score - a.score);
  return ok[0] || null;
}

function toLines(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.replace(/\t/g, ' ').replace(/ /g, ' '))
    .filter((l) => l.trim());
}

function parseContractText(text, opts = {}) {
  const ownerNames = opts.ownerNames || [];
  const lines = toLines(text);
  const joined = lines.join('\n');

  const fields = {};
  const evidence = {};

  const name = labelValue(lines, ['공사계약명', '공사명', '계약명', '계약건명', '건명', '용역명']);
  if (name) {
    fields.name = name.value.replace(/\s*(?:계약번호|계약일자).*$/, '');
    evidence.name = name.line;
  }

  const no = /계\s*약\s*번\s*호\s*[:：]?\s*([A-Za-z0-9][A-Za-z0-9\-_/]{2,})/.exec(joined);
  if (no) { fields.contractNo = no[1]; evidence.contractNo = no[0]; }

  const comp = findCompany(lines, ownerNames);
  if (comp) { fields.companyName = comp.value; evidence.companyName = comp.line; }

  const cd = firstDateByLabels(lines, CONTRACT_DATE_LABELS);
  const per = findPeriod(lines, cd && cd.date);
  if (per) { fields.startDate = per.start; fields.endDate = per.end; evidence.period = per.line; }

  const amt = findAmount(lines);
  if (amt) { fields.amount = amt.value; evidence.amount = amt.line; }

  if (/단\s*가\s*계\s*약|단가\s*공사|연간\s*단가/.test(joined)) {
    fields.type = 'UNIT_PRICE';
    evidence.type = (/.*단\s*가\s*계\s*약.*/.exec(joined) || [''])[0].trim();
  } else {
    fields.type = 'GENERAL';
  }

  const required = ['name', 'companyName', 'startDate', 'endDate', 'amount'];
  const missing = required.filter((k) => fields[k] == null || fields[k] === '');
  return { fields, evidence, missing, textPreview: joined.slice(0, 3000) };
}

// 기술지도 계약서: 계약일자 / 기술지도 계약기간 / 기술지도 횟수
function parseTgContractText(text) {
  const lines = toLines(text);
  const joined = lines.join('\n');
  const fields = {};
  const evidence = {};
  const cd = firstDateByLabels(lines, CONTRACT_DATE_LABELS);
  if (cd) { fields.contractDate = cd.date; evidence.contractDate = cd.line; }
  const per = periodByLabels(lines, ['기술지도기간', '지도기간', '기술지도계약기간', '계약기간', '용역기간', '공사기간'], cd && cd.date) || findPeriod(lines, cd && cd.date);
  if (per) { fields.guidanceStart = per.start; fields.guidanceEnd = per.end; evidence.period = per.line; }
  const cnt = /(?:기\s*술\s*지\s*도\s*횟\s*수|지\s*도\s*횟\s*수|방\s*문\s*횟\s*수|총\s*지\s*도\s*횟\s*수|횟\s*수)\s*(?:\([^)]*\))?\s*[:：]?\s*(?:총\s*)?(\d{1,3})\s*회/.exec(joined)
    || /(?:기술지도|지도)[^\n]{0,20}?(?:총\s*)?(\d{1,3})\s*회/.exec(joined);
  if (cnt) { fields.plannedCount = Number(cnt[1]); evidence.plannedCount = cnt[0].trim(); }
  if (!fields.contractDate) {
    // 계약서 끝의 작성일("2026년 10월 1일")을 계약일로 본다
    const all = datesIn(joined, { fourDigitOnly: true });
    if (all.length) { fields.contractDate = all[all.length - 1]; evidence.contractDate = '(문서의 마지막 날짜)'; }
  }
  const missing = ['contractDate', 'guidanceStart', 'guidanceEnd', 'plannedCount'].filter((k) => fields[k] == null);
  return { fields, evidence, missing, textPreview: joined.slice(0, 3000) };
}

// ───────────────────────── OCR(스캔 문서) ─────────────────────────
// 글자층이 거의 없는 PDF(스캔본)와 이미지 파일은 OCR로 읽는다. OCR 엔진은 실행 환경별 구현(./ocr)을 쓴다.
const OCR_MIN_CHARS = 40; // 글자층이 이보다 적으면 스캔본으로 본다

// OCR이 자주 틀리는 글자: 라벨(콜론 앞) 부분에만 바로잡는다 — 값(업체명 등)은 건드리지 않음
const LABEL_FIX = { 맥: '액', 앤: '액', 엑: '액', 삼: '상', 점: '정', 잠: '장', 뮤: '유', 메: '에', 막: '약', 림: '링', 엄: '업', 겸: '결', 긴: '간', 렵: '력', 몀: '명', 멍: '명' };
const KNOWN_LABELS = ['계약금액', '계약기간', '계약상대자', '계약일자', '계약번호', '계약명', '공사명', '공사기간', '공사금액', '공사장소', '업체명', '도급금액', '수급인', '발주자', '기술지도기간', '기술지도횟수', '착공일', '준공예정일', '준공일', '상호'];

function fixLabel(label) {
  const compact = label.replace(/\s/g, '');
  if (KNOWN_LABELS.some((k) => compact.includes(k))) return label;
  const fixed = label.replace(/[가-힣]/g, (c) => LABEL_FIX[c] || c);
  return KNOWN_LABELS.some((k) => fixed.replace(/\s/g, '').includes(k)) ? fixed : label;
}

function normalizeOcrText(text) {
  return String(text || '').split('\n').map((line) => {
    let l = line
      .replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
      .replace(/(\d)\s*[.,]\s*(?=\d{3}\b)/g, (m, d) => `${d},`) // 1.000 / 1 ,000 → 1,000 (천 단위)
      .replace(/\bW\s?(?=\d{1,3}(?:,\d{3})+)/g, '₩')
      // '원'을 8/B/임 등으로 잘못 읽은 경우: 정상 천 단위 숫자 뒤에 붙은 한 글자
      .replace(/(\d{1,3}(?:,\d{3})+)[8B日읨임](?=\s|\(|\)|$)/g, '$1원');
    const m = /^([^:：]{1,24})([:：])(.*)$/.exec(l);
    if (m) l = fixLabel(m[1]) + m[2] + m[3];
    return l;
  }).join('\n');
}

async function extractTextInfo(buf, filename) {
  const ext = path.extname(filename || '').toLowerCase();
  const isImage = ['.jpg', '.jpeg', '.png'].includes(ext);
  let text = isImage ? '' : await extractText(buf, filename);
  const meaningful = String(text || '').replace(/\s/g, '').length;
  if ((ext === '.pdf' && meaningful < OCR_MIN_CHARS) || isImage) {
    let ocr;
    try {
      ocr = require('./ocr');
    } catch {
      ocr = null;
    }
    if (!ocr || (ocr.enabled && !ocr.enabled())) return { text, ocr: null, ocrUnavailable: true };
    const r = isImage ? await ocr.ocrImage(buf) : await ocr.ocrPdf(buf);
    return { text: normalizeOcrText(r.text), ocr: { pages: r.pages, totalPages: r.totalPages, confidence: r.confidence, ms: r.ms } };
  }
  return { text, ocr: null };
}

async function readText(buf, filename) {
  let info;
  try {
    info = await extractTextInfo(buf, filename);
  } catch (e) {
    if (/\.(pdf|jpe?g|png)$/i.test(filename || '')) return { text: null, ocrError: e.message };
    throw e;
  }
  if (!info.text || info.text.replace(/\s/g, '').length < 10) return { ...info, text: null };
  return info;
}

const NO_TEXT = '텍스트를 추출하지 못했습니다(스캔 이미지 PDF 등). 정보를 직접 입력해 주세요.';

function ocrNote(info) {
  if (info.ocrError) return `스캔 문서로 보여 OCR(문자 인식)을 시도했으나 실패했습니다: ${info.ocrError} 정보를 직접 입력해 주세요.`;
  if (info.ocrUnavailable) return 'OCR(문자 인식)을 사용할 수 없는 환경입니다. 정보를 직접 입력해 주세요.';
  return NO_TEXT;
}

function withOcr(result, info) {
  if (!info.ocr) return result;
  const o = info.ocr;
  const pages = o.totalPages > o.pages ? `${o.totalPages}쪽 중 앞 ${o.pages}쪽` : `${o.pages}쪽`;
  return {
    ...result,
    ocr: o,
    notice: `스캔 문서로 판단되어 OCR(문자 인식)로 읽었습니다 — ${pages}, 인식 신뢰도 ${o.confidence}%, ${(o.ms / 1000).toFixed(1)}초. 숫자·글자가 잘못 읽혔을 수 있으니 노란 칸을 계약서와 꼭 대조해 주세요.`,
  };
}

async function analyzeContract(buf, filename, opts = {}) {
  const info = await readText(buf, filename);
  if (!info.text) return { fields: {}, evidence: {}, missing: ['name', 'companyName', 'startDate', 'endDate', 'amount'], textPreview: '', warning: ocrNote(info) };
  return withOcr(parseContractText(info.text, opts), info);
}

async function analyzeTgContract(buf, filename) {
  const info = await readText(buf, filename);
  if (!info.text) return { fields: {}, evidence: {}, missing: ['contractDate', 'guidanceStart', 'guidanceEnd', 'plannedCount'], textPreview: '', warning: ocrNote(info) };
  return withOcr(parseTgContractText(info.text), info);
}

module.exports = { analyzeContract, analyzeTgContract, parseContractText, parseTgContractText, parseKoreanAmount, extractText, extractTextInfo, normalizeOcrText, datesIn, cellText };
