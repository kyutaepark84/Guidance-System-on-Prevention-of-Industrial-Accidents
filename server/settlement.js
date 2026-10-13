'use strict';
// 단가업체 월별 정산실적 Upload 처리
// 지원 양식
//  ① 세로형: 계약번호 | 공사계약명 | 업체명 | 정산월(YYYY-MM) | 정산금액
//  ② 가로형: 계약번호 | 공사계약명 | 업체명 | 연도 | 1월 | 2월 | ... | 12월   (또는 2026-01, 2026-02 ... 헤더)
// 추후: 구매시스템/SAP 월별 정산금액 연동으로 대체
const ExcelJS = require('exceljs');
const path = require('path');
const store = require('./db');
const { cellText } = require('./extract');

const norm = (s) => String(s || '').replace(/\(주\)|㈜|주식회사|\s|\[단가계약\]|단가계약/g, '').toLowerCase();

function toNumber(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  const n = Number(String(v).replace(/[,\s원₩]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function toMonth(v, yearHint) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return v.toISOString().slice(0, 7);
  const s = String(v).trim();
  let m = /^(\d{4})\s*[-./년]\s*(\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}`;
  m = /^(\d{4})(\d{2})$/.exec(s);
  if (m) return `${m[1]}-${m[2]}`;
  m = /^(\d{1,2})\s*월$/.exec(s);
  if (m && yearHint) return `${yearHint}-${m[1].padStart(2, '0')}`;
  return null;
}

async function readRows(buf, filename) {
  const ext = path.extname(filename || '').toLowerCase();
  const wb = new ExcelJS.Workbook();
  if (ext === '.csv') {
    const text = buf.toString('utf8').replace(/^﻿/, '');
    return text.split(/\r?\n/).filter((l) => l.trim()).map(splitCsv);
  }
  if (ext !== '.xlsx') throw new Error('정산실적은 XLSX 또는 CSV 파일로 올려 주세요.');
  await wb.xlsx.load(buf);
  const ws = wb.worksheets[0];
  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const arr = [];
    row.eachCell({ includeEmpty: true }, (c, col) => {
      const v = c.value;
      arr[col - 1] = v instanceof Date ? v : (v && typeof v === 'object' && 'result' in v ? v.result : (typeof v === 'number' ? v : cellText(c)));
    });
    rows.push(arr);
  });
  return rows;
}

function splitCsv(line) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

function findHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const h = (rows[i] || []).map((x) => String(x ?? '').replace(/\s/g, ''));
    if (h.some((x) => /정산금액|금액|^\d{1,2}월$|^\d{4}[-.]\d{1,2}$/.test(x)) && h.some((x) => /계약번호|계약명|공사명|업체명/.test(x))) {
      return { idx: i, header: h };
    }
  }
  throw new Error('헤더 행을 찾을 수 없습니다. 양식(계약번호/공사계약명/업체명/정산월/정산금액)을 확인해 주세요.');
}

function matchProject(projects, rec) {
  const units = projects.filter((p) => p.type === 'UNIT_PRICE');
  if (rec.contractNo) {
    const p = units.find((x) => x.contractNo && x.contractNo === String(rec.contractNo).trim());
    if (p) return p;
  }
  if (rec.name) {
    const p = units.find((x) => norm(x.name) === norm(rec.name));
    if (p) return p;
  }
  if (rec.company) {
    const cands = units.filter((x) => norm(x.companyName) === norm(rec.company) && x.status !== 'CLOSED');
    if (cands.length === 1) return cands[0];
  }
  return null;
}

async function importSettlements(buf, filename, actor) {
  const db = store.get();
  const rows = await readRows(buf, filename);
  const { idx, header } = findHeader(rows);
  const col = (re) => header.findIndex((x) => re.test(x));
  const cNo = col(/계약번호/), cName = col(/계약명|공사명/), cComp = col(/업체명|협력업체/);
  const cMonth = col(/정산월|정산년월|년월|^월$|기준월/), cAmt = col(/정산금액|^금액$/), cYear = col(/^연도$|^년도$/);
  const wideCols = header.map((h, i) => ({ h, i })).filter(({ h }) => /^\d{1,2}월$|^\d{4}[-.]\d{1,2}$/.test(h));

  const recs = [];
  for (const r of rows.slice(idx + 1)) {
    if (!r || r.every((x) => x == null || String(x).trim() === '')) continue;
    const base = { contractNo: cNo >= 0 ? r[cNo] : '', name: cName >= 0 ? r[cName] : '', company: cComp >= 0 ? r[cComp] : '' };
    if (cMonth >= 0 && cAmt >= 0) {
      recs.push({ ...base, month: toMonth(r[cMonth]), amount: toNumber(r[cAmt]) });
    } else if (wideCols.length) {
      const year = cYear >= 0 ? String(r[cYear]).trim() : String(new Date().getFullYear());
      for (const { h, i } of wideCols) {
        const amount = toNumber(r[i]);
        if (amount == null) continue;
        recs.push({ ...base, month: toMonth(h, year), amount });
      }
    }
  }
  if (!recs.length) throw new Error('정산 데이터 행이 없습니다.');

  let inserted = 0, updated = 0;
  const unmatched = [], invalid = [];
  const affected = new Set();
  const now = new Date().toISOString();
  for (const rec of recs) {
    if (!rec.month || rec.amount == null) { invalid.push(rec); continue; }
    const p = matchProject(db.projects, rec);
    if (!p) { unmatched.push(rec); continue; }
    const ex = db.settlements.find((s) => s.projectId === p.id && s.month === rec.month);
    if (ex) {
      if (ex.amount !== rec.amount) { ex.amount = rec.amount; ex.updatedAt = now; ex.source = filename; updated++; }
    } else {
      db.settlements.push({ id: store.id('s'), projectId: p.id, month: rec.month, amount: rec.amount, source: filename, uploadedBy: actor.id, uploadedAt: now });
      inserted++;
    }
    affected.add(p.id);
  }
  return { total: recs.length, inserted, updated, unmatched, invalid, affected: [...affected] };
}

async function templateWorkbook(projects, year) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('월별정산실적');
  ws.columns = [
    { header: '계약번호', key: 'no', width: 16 },
    { header: '공사계약명', key: 'name', width: 40 },
    { header: '업체명', key: 'comp', width: 18 },
    { header: '정산월', key: 'month', width: 10 },
    { header: '정산금액', key: 'amt', width: 16, style: { numFmt: '#,##0' } },
  ];
  ws.getRow(1).font = { bold: true };
  const units = projects.filter((p) => p.type === 'UNIT_PRICE' && p.status !== 'CLOSED');
  for (const p of units) ws.addRow({ no: p.contractNo, name: p.name, comp: p.companyName, month: `${year}-01`, amt: 0 });
  const g = wb.addWorksheet('작성안내');
  g.addRows([
    ['■ 단가계약 월별 정산실적 Upload 양식'],
    ['1. 한 행에 한 계약의 한 달 정산금액을 입력합니다. (정산월: YYYY-MM)'],
    ['2. 계약번호가 일치하는 단가계약에 반영되며, 계약번호가 없으면 공사계약명 → 업체명 순으로 매칭합니다.'],
    ['3. 같은 계약·같은 월을 다시 올리면 금액이 갱신됩니다.'],
    ['4. 가로형(연도 | 1월 ~ 12월) 양식도 지원합니다.'],
  ]);
  g.getColumn(1).width = 100;
  return wb.xlsx.writeBuffer();
}

module.exports = { importSettlements, templateWorkbook, toMonth, matchProject };
