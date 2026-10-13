'use strict';
// 공사 계약서 파일에서 텍스트를 뽑고, 공사계약명/업체명/계약기간/계약금액 등을 추출한다.
// DEMO 단계: 규칙(정규식) 기반. 추출 결과는 반드시 등록 화면에서 사람이 확인·수정 후 저장한다.
// 추후: 구매시스템/SAP 계약정보 연동 시 이 모듈을 연동 어댑터로 대체한다.
const path = require('path');
const JSZip = require('jszip');
const ExcelJS = require('exceljs');

// ───────────────────────── 텍스트 추출 ─────────────────────────

function decodeText(buf) {
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('�')) return utf8.replace(/^﻿/, '');
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

async function pdfText(buf) {
  const { PDFParse } = require('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  try {
    const res = await parser.getText();
    return res.text || '';
  } finally {
    await parser.destroy().catch(() => {});
  }
}

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
    case '.hwp':
      throw new Error('HWP(구버전 한글) 파일은 DEMO에서 자동 분석을 지원하지 않습니다. PDF 또는 HWPX로 저장 후 올리거나, 정보를 직접 입력해 주세요.');
    default:
      throw new Error(`지원하지 않는 파일 형식입니다(${ext || '확장자 없음'}). PDF, DOCX, HWPX, XLSX, TXT를 지원합니다.`);
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

const DATE_RE = /(\d{4})\s*(?:[.\-/]|년)\s*(\d{1,2})\s*(?:[.\-/]|월)\s*(\d{1,2})\s*(?:일|\.)?/g;

function normDate(y, m, d) {
  const mm = String(m).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  if (+m < 1 || +m > 12 || +d < 1 || +d > 31) return null;
  return `${y}-${mm}-${dd}`;
}

function datesIn(str) {
  const out = [];
  let m;
  DATE_RE.lastIndex = 0;
  while ((m = DATE_RE.exec(str))) {
    const d = normDate(m[1], m[2], m[3]);
    if (d) out.push(d);
  }
  return out;
}

// ───────────────────────── 필드 추출 ─────────────────────────

function cleanValue(v) {
  return String(v || '')
    .replace(/^[\s:：\-|]+/, '')
    .replace(/[\s|]+$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// 라벨 다음에 오는 값(같은 줄)을 찾는다. 라벨 글자 사이 공백 허용("공 사 명")
// 1차: "라벨 : 값" 형태(콜론 필수) / 2차: 줄 맨 앞의 라벨(표 형태, 콜론 없음)
function labelValue(lines, labels) {
  const esc = (c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const strict of [true, false]) {
    for (const label of labels) {
      const pat = label.split('').map(esc).join('\\s*');
      const re = strict
        ? new RegExp(`(?:^|[\\s|①-⑳0-9.)])${pat}\\s*(?:\\([^)]*\\))?\\s*[:：]\\s*(.*)$`)
        : new RegExp(`^\\s*(?:[①-⑳]|\\d+[.)])?\\s*${pat}\\s*(?:\\([^)]*\\))?\\s+(.+)$`);
      for (let i = 0; i < lines.length; i++) {
        const m = re.exec(lines[i]);
        if (!m) continue;
        let v = cleanValue(m[1]);
        if (!v && lines[i + 1]) v = cleanValue(lines[i + 1]); // 표에서 값이 다음 줄에 있는 경우
        if (v) return { value: v, line: lines[i].trim() };
      }
    }
  }
  return null;
}

function findAmount(lines) {
  const labels = ['총계약금액', '계약금액', '공사금액', '도급금액', '계약총액', '총공사비', '연간계약금액', '추정계약금액'];
  for (const label of labels) {
    const pat = label.split('').join('\\s*');
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

function findPeriod(lines) {
  const labels = ['계약기간', '공사기간', '이행기간', '용역기간', '작업기간', '계약 기간'];
  for (const label of labels) {
    const re = new RegExp(label.split('').join('\\s*'));
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      const ds = datesIn(lines[i] + ' ' + (lines[i + 1] || ''));
      if (ds.length >= 2) return { start: ds[0], end: ds[1], line: lines[i].trim() };
    }
  }
  // 착공일/준공일 별도 기재
  const s = labelValue(lines, ['착공일자', '착공일', '착공예정일', '계약시작일']);
  const e = labelValue(lines, ['준공예정일자', '준공일자', '준공예정일', '준공일', '완료일', '계약종료일']);
  const sd = s && datesIn(s.value)[0];
  const ed = e && datesIn(e.value)[0];
  if (sd && ed) return { start: sd, end: ed, line: `${s.line} / ${e.line}` };
  return null;
}

function stripTrailingNoise(v) {
  return v.replace(/\s*(?:\(인\)|\(서명\)|\(날인\)|인$).*$/, '').trim();
}

function parseContractText(text) {
  const lines = String(text || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.replace(/\t/g, ' ').replace(/ /g, ' '))
    .filter((l) => l.trim());
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

  const comp = labelValue(lines, ['업체명', '계약상대자', '수급인', '수급자', '상호', '회사명', '협력업체']);
  if (comp) {
    fields.companyName = stripTrailingNoise(comp.value.replace(/^(?:상\s*호|업체명|회사명)\s*[:：]\s*/, '').replace(/\s*(?:대표이사|대표자|대표|사업자등록번호|주소).*$/, ''));
    evidence.companyName = comp.line;
  } else {
    const m = /((?:\(주\)|㈜|주식회사)\s*[가-힣A-Za-z0-9]+|[가-힣A-Za-z0-9]+\s*(?:\(주\)|㈜))/.exec(joined);
    if (m) { fields.companyName = m[1].trim(); evidence.companyName = m[0]; }
  }

  const per = findPeriod(lines);
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

async function analyzeContract(buf, filename) {
  const text = await extractText(buf, filename);
  if (!text || text.replace(/\s/g, '').length < 10) {
    return {
      fields: {}, evidence: {}, missing: ['name', 'companyName', 'startDate', 'endDate', 'amount'], textPreview: '',
      warning: '텍스트를 추출하지 못했습니다(스캔 이미지 PDF 등). 정보를 직접 입력해 주세요.',
    };
  }
  return parseContractText(text);
}

module.exports = { analyzeContract, parseContractText, parseKoreanAmount, extractText, datesIn, cellText };
