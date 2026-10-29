'use strict';
// 시스템 관리자: 부서·업체·기관별 담당자(사용자) 일괄 Upload
// 양식: 역할 | 소속 | 이름 | 직책 | 이메일 | 휴대폰
//  - 소속이 없으면 새로 만든다(부서/협력업체/기술지도기관)
//  - 같은 이메일, 또는 같은 역할·소속·이름이면 기존 사용자를 갱신한다
const ExcelJS = require('exceljs');
const store = require('./db');
const notify = require('./notify');
const { cellText } = require('./extract');

const ROLE_BY_LABEL = Object.fromEntries(Object.entries(notify.ROLE_LABEL).map(([k, v]) => [v.replace(/\s/g, ''), k]));
const ALIAS = { 구매: 'PURCHASE', 구매팀: 'PURCHASE', 협력업체관리: 'PARTNER_MGMT', 공사담당: 'PARTNER_MGMT', 관리부서: 'PARTNER_MGMT', 안전보건: 'SAFETY', 안전보건환경: 'SAFETY', 기관: 'AGENCY', 기술지도: 'AGENCY', 업체: 'CONTRACTOR', 관리자: 'ADMIN' };

function toRole(v) {
  const s = String(v || '').replace(/\s/g, '');
  if (notify.ROLE_LABEL[s.toUpperCase()]) return s.toUpperCase();
  return ROLE_BY_LABEL[s] || ALIAS[s] || null;
}

const norm = (s) => String(s || '').replace(/\(주\)|㈜|주식회사|\s/g, '').toLowerCase();

function resolveOrg(db, role, name, created) {
  if (role === 'ADMIN') return null;
  const nm = String(name || '').trim();
  if (!nm) throw new Error('소속을 입력해 주세요.');
  if (role === 'CONTRACTOR' || role === 'AGENCY') {
    const list = role === 'CONTRACTOR' ? db.companies : db.agencies;
    let o = list.find((x) => norm(x.name) === norm(nm));
    if (!o) {
      o = { id: store.id(role === 'CONTRACTOR' ? 'co' : 'ag'), name: nm, phone: '', email: '' };
      list.push(o);
      created.push(`${notify.ROLE_LABEL[role]}: ${nm}`);
    }
    return o.id;
  }
  let d = db.departments.find((x) => norm(x.name) === norm(nm));
  if (!d) {
    d = { id: store.id('d'), name: nm, kind: role };
    db.departments.push(d);
    created.push(`부서: ${nm}`);
  } else if (d.kind !== role) {
    throw new Error(`'${nm}'은(는) ${notify.ROLE_LABEL[d.kind] || d.kind} 부서입니다. 역할을 확인해 주세요.`);
  }
  return d.id;
}

async function importUsers(buf, filename) {
  const db = store.get();
  const rows = [];
  if (/\.csv$/i.test(filename || '')) {
    const text = new TextDecoder('utf-8').decode(buf).replace(/^﻿/, '');
    for (const l of text.split(/\r?\n/)) if (l.trim()) rows.push(l.split(',').map((x) => x.trim().replace(/^"|"$/g, '')));
  } else {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    wb.worksheets[0].eachRow({ includeEmpty: false }, (row) => {
      const arr = [];
      row.eachCell({ includeEmpty: true }, (c, col) => { arr[col - 1] = cellText(c).trim(); });
      rows.push(arr);
    });
  }
  const hi = rows.findIndex((r) => r.some((x) => /역할/.test(x || '')) && r.some((x) => /이름|성명/.test(x || '')));
  if (hi < 0) throw new Error('헤더 행(역할 | 소속 | 이름 | 직책 | 이메일 | 휴대폰)을 찾을 수 없습니다.');
  const h = rows[hi].map((x) => String(x || '').replace(/\s/g, ''));
  const col = (re) => h.findIndex((x) => re.test(x));
  const c = { role: col(/역할|구분/), org: col(/소속|부서|업체|기관/), name: col(/이름|성명/), title: col(/직책|직위|담당업무/), email: col(/이메일|e-?mail/i), phone: col(/휴대폰|전화|연락처|핸드폰/) };
  let inserted = 0, updated = 0;
  const errors = [];
  const created = [];
  rows.slice(hi + 1).forEach((r, i) => {
    const rowNo = hi + i + 2;
    const get = (k) => (c[k] >= 0 ? String(r[c[k]] || '').trim() : '');
    if (!r.some((x) => String(x || '').trim())) return;
    try {
      const role = toRole(get('role'));
      if (!role) throw new Error(`역할을 확인해 주세요(${Object.values(notify.ROLE_LABEL).join(', ')}).`);
      const name = get('name');
      if (!name) throw new Error('이름을 입력해 주세요.');
      const orgId = resolveOrg(db, role, get('org'), created);
      const email = get('email');
      let u = (email && db.users.find((x) => x.email && x.email.toLowerCase() === email.toLowerCase()))
        || db.users.find((x) => x.role === role && x.orgId === orgId && x.name === name);
      const rec = { name, role, orgId, title: get('title'), email, phone: get('phone'), active: true };
      if (u) { Object.assign(u, Object.fromEntries(Object.entries(rec).filter(([, v]) => v !== '' && v !== undefined))); updated++; } else {
        u = { id: store.id('u'), ...rec };
        db.users.push(u);
        inserted++;
      }
    } catch (e) {
      errors.push({ row: rowNo, message: e.message });
    }
  });
  return { inserted, updated, errors, created };
}

async function usersTemplate() {
  const db = store.get();
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('담당자');
  ws.columns = [
    { header: '역할', key: 'role', width: 18 },
    { header: '소속', key: 'org', width: 28 },
    { header: '이름', key: 'name', width: 12 },
    { header: '직책', key: 'title', width: 18 },
    { header: '이메일', key: 'email', width: 28 },
    { header: '휴대폰', key: 'phone', width: 16 },
  ];
  ws.getRow(1).font = { bold: true };
  const orgName = (u) => (db.departments.find((d) => d.id === u.orgId) || db.companies.find((x) => x.id === u.orgId) || db.agencies.find((x) => x.id === u.orgId) || {}).name || '';
  for (const u of db.users.filter((x) => x.role !== 'ADMIN')) ws.addRow({ role: notify.ROLE_LABEL[u.role], org: orgName(u), name: u.name, title: u.title || '', email: u.email || '', phone: u.phone || '' });
  const g = wb.addWorksheet('작성안내');
  g.getColumn(1).width = 110;
  g.addRows([
    ['■ 담당자 일괄 등록 양식'],
    [`1. 역할: ${Object.entries(notify.ROLE_LABEL).filter(([k]) => k !== 'ADMIN').map(([, v]) => v).join(' / ')}`],
    ['2. 소속: 부서명(구매부서·협력업체 관리부서·안전보건환경부서), 협력업체명, 기술지도기관명. 없는 소속은 새로 만들어집니다.'],
    ['3. 같은 이메일이거나 같은 역할·소속·이름이면 기존 담당자 정보가 갱신됩니다.'],
    [`4. 현재 협력업체 관리부서: ${db.departments.filter((d) => d.kind === 'PARTNER_MGMT').map((d) => d.name).join(', ')}`],
  ]);
  return wb.xlsx.writeBuffer();
}

module.exports = { importUsers, usersTemplate, toRole };
