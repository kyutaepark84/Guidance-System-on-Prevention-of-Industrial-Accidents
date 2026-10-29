'use strict';
// 화면용 데이터 구성(서버 API와 브라우저 단독 실행 버전이 함께 사용)
const store = require('./db');
const dates = require('./dates');
const wf = require('./workflow');
const notify = require('./notify');

const canSeeAllMail = (u) => ['ADMIN', 'SAFETY', 'PARTNER_MGMT', 'PURCHASE'].includes(u.role);

function contactsView(p) {
  const db = store.get();
  const out = {};
  for (const role of wf.CONTACT_ROLES) {
    const u = db.users.find((x) => x.id === notify.contactOf(p, role));
    out[role] = notify.validContact(p, role, u) ? { id: u.id, name: u.name, title: u.title || '', email: u.email || '', phone: u.phone || '' } : null;
  }
  return out;
}

function projectView(p, user, detail = false) {
  const db = store.get();
  const t = wf.today();
  const allTasks = wf.tasks(p, t);
  const v = {
    ...p,
    history: detail ? p.history : undefined,
    statusLabel: wf.STATUS[p.status]?.label || p.status,
    statusColor: wf.STATUS[p.status]?.color,
    step: wf.STATUS[p.status]?.step,
    deptName: db.departments.find((d) => d.id === p.deptId)?.name || '',
    agencyName: db.agencies.find((a) => a.id === p.agencyId)?.name || '',
    contactsView: contactsView(p),
    managerName: contactsView(p).PARTNER_MGMT?.name || '',
    cycle: wf.cycleInfo(p, t),
    gaps: wf.cycleGaps(p, t),
    endNoticeDays: wf.endNoticeDaysFor(p),
    tasks: allTasks,
    myTasks: allTasks.filter((x) => user.role === 'ADMIN' || x.role === user.role),
  };
  if (detail) {
    v.files = db.files.filter((f) => f.projectId === p.id).map((f) => ({ ...f, uploaderName: db.users.find((u) => u.id === f.uploadedBy)?.name || '' }));
    v.settlements = db.settlements.filter((s) => s.projectId === p.id).sort((a, b) => a.month.localeCompare(b.month));
    v.notifications = db.notifications.filter((n) => n.projectId === p.id && (canSeeAllMail(user) || n.toUserId === user.id)).slice(-200).reverse();
    v.actions = wf.availableActions(p, user);
  }
  return JSON.parse(JSON.stringify(v));
}

function meta(extra = {}) {
  const db = store.get();
  return {
    today: wf.today(),
    realToday: dates.todayReal(),
    status: wf.STATUS,
    visitStatus: wf.VISIT_STATUS,
    gapReasons: wf.GAP_REASONS,
    contactRoles: wf.CONTACT_ROLES,
    roles: notify.ROLE_LABEL,
    actions: Object.fromEntries(Object.entries(wf.ACTIONS).map(([k, a]) => [k, { label: a.label, roles: a.roles }])),
    settings: wf.settings(),
    departments: db.departments,
    companies: db.companies,
    agencies: db.agencies,
    users: db.users.map(({ id, name, role, orgId, title, active, email, phone }) => ({ id, name, role, orgId, title, active, email, phone })),
    lastDailyCheck: db.meta.lastDailyCheck || null,
    ...extra,
  };
}

function dashboard(user) {
  const db = store.get();
  const t = wf.today();
  const visible = db.projects.filter((p) => wf.canSee(user, p));
  const counts = {};
  for (const p of visible) counts[p.status] = (counts[p.status] || 0) + 1;
  const myTasks = [];
  const alerts = [];
  for (const p of visible) {
    for (const k of wf.tasks(p, t)) if (user.role === 'ADMIN' || k.role === user.role) myTasks.push({ projectId: p.id, projectName: p.name, status: p.status, ...k });
    const c = wf.cycleInfo(p, t);
    if (c && c.level === 'overdue') alerts.push({ level: 'danger', projectId: p.id, projectName: p.name, text: `기술지도 주기 초과 (기한 ${c.nextDue}) — 누락 위험` });
    if (c && c.endIn >= 0 && c.endIn <= wf.endNoticeDaysFor(p) && p.status === 'ACTIVE') alerts.push({ level: 'warn', projectId: p.id, projectName: p.name, text: `기술지도 기간 만료 D-${c.endIn} (${p.guidancePeriod.end})` });
    if (c && c.endIn < 0) alerts.push({ level: 'danger', projectId: p.id, projectName: p.name, text: '기술지도 기간 경과 — 종결/연장 미조치' });
    if (p.status === 'MONITORING' && p.judgment?.warning) alerts.push({ level: 'warn', projectId: p.id, projectName: p.name, text: `단가계약 누계 ${(p.judgment.ratio * 100).toFixed(1)}% — 기준 근접` });
    if (p.status === 'DOCS_REQUESTED' && !p.agencyId) alerts.push({ level: 'warn', projectId: p.id, projectName: p.name, text: '기술지도기관 미지정' });
    const open = wf.cycleGaps(p, t).filter((g) => !g.reason).length;
    if (open) alerts.push({ level: 'warn', projectId: p.id, projectName: p.name, text: `기술지도 미실시 사유 미작성 ${open}건` });
  }
  const upcoming = [];
  for (const p of visible) for (const v of p.visits || []) if (v.status === 'SCHEDULED') upcoming.push({ projectId: p.id, projectName: p.name, date: v.plannedDate, time: v.time, round: v.round, agency: db.agencies.find((a) => a.id === p.agencyId)?.name });
  upcoming.sort((a, b) => a.date.localeCompare(b.date));
  const unread = db.notifications.filter((n) => n.toUserId === user.id && !n.read && n.channel === 'EMAIL').length;
  return { today: t, counts, total: visible.length, myTasks, alerts, upcoming: upcoming.slice(0, 10), unread, lastDailyCheck: db.meta.lastDailyCheck };
}

function settlementsView(user, year) {
  const db = store.get();
  const units = db.projects.filter((p) => p.type === 'UNIT_PRICE' && wf.canSee(user, p));
  return {
    year,
    threshold: wf.settings().amountThreshold,
    rows: units.map((p) => {
      const ss = db.settlements.filter((s) => s.projectId === p.id && s.month.startsWith(year));
      const months = {};
      for (const s of ss) months[s.month.slice(5, 7)] = s.amount;
      return { ...projectView(p, user), months, cumulative: ss.reduce((a, s) => a + s.amount, 0) };
    }),
  };
}

function applySettings(s) {
  const db = store.get();
  const bad = (k) => new wf.WfError(`${k} 값이 올바르지 않습니다.`);
  const num = (k, min) => {
    if (k in s) {
      const n = Number(s[k]);
      if (!(n >= min)) throw bad(k);
      db.settings[k] = n;
    }
  };
  num('amountThreshold', 0); num('periodMonths', 0); num('warnRatio', 0); num('endNoticeDaysGeneral', 0); num('endNoticeDaysUnit', 0); num('cycleDays', 1); num('cycleRemindDays', 0);
  for (const k of ['notifyEmail', 'notifySms']) if (k in s) db.settings[k] = !!s[k];
  if ('defaultAgencyId' in s) db.settings.defaultAgencyId = s.defaultAgencyId || null;
  if ('ownerCompanyNames' in s) {
    const list = Array.isArray(s.ownerCompanyNames) ? s.ownerCompanyNames : String(s.ownerCompanyNames || '').split(',');
    db.settings.ownerCompanyNames = list.map((x) => String(x).trim()).filter(Boolean);
  }
  if ('demoToday' in s) {
    if (s.demoToday && !dates.isValid(s.demoToday)) throw new wf.WfError('데모 기준일 형식(YYYY-MM-DD)을 확인해 주세요.');
    db.settings.demoToday = s.demoToday || null;
  }
  return { settings: wf.settings(), dailyCheck: wf.dailyCheck() };
}

// 관리자: 기준정보(사용자·업체·기관·부서) 추가/수정
function upsertMaster(kind, b) {
  const db = store.get();
  if (!['users', 'companies', 'agencies', 'departments'].includes(kind)) throw new wf.WfError('알 수 없는 요청입니다.', 404);
  if (!b || !String(b.name || '').trim()) throw new wf.WfError('이름을 입력해 주세요.');
  if (kind === 'users' && !notify.ROLE_LABEL[b.role]) throw new wf.WfError('역할을 선택해 주세요.');
  if (kind === 'departments' && !['PURCHASE', 'PARTNER_MGMT', 'SAFETY'].includes(b.kind)) throw new wf.WfError('부서 구분을 선택해 주세요.');
  if (kind === 'departments' && !b.id && db.departments.some((d) => d.name === b.name.trim())) throw new wf.WfError('이미 있는 부서입니다.');
  let rec = b.id && db[kind].find((x) => x.id === b.id);
  if (rec) Object.assign(rec, b);
  else { rec = { ...b, name: b.name.trim(), id: store.id(kind.slice(0, 2)), active: true }; db[kind].push(rec); }
  return rec;
}

// 공사 목록 엑셀 내보내기
async function exportProjects(user) {
  const ExcelJS = require('exceljs');
  const db = store.get();
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('기술지도 대상 공사');
  ws.columns = [
    ['계약번호', 14], ['공사계약명', 40], ['구분', 10], ['업체명', 18], ['계약시작', 12], ['계약종료', 12], ['계약금액', 15],
    ['누계정산(당해)', 15], ['판정', 10], ['상태', 22], ['협력업체 관리부서', 16], ['기술지도기관', 26], ['지도기간', 24], ['지도 실시', 10], ['다음 지도기한', 14], ['미실시 사유 미작성', 12], ['판정근거', 80],
  ].map(([header, width]) => ({ header, width }));
  ws.getRow(1).font = { bold: true };
  for (const p of db.projects.filter((x) => wf.canSee(user, x))) {
    const v = projectView(p, user);
    ws.addRow([p.contractNo, p.name, p.type === 'UNIT_PRICE' ? '단가계약' : '일반', p.companyName, p.startDate, p.endDate, p.amount,
      p.type === 'UNIT_PRICE' ? p.judgment?.cumulative?.currentYearAmount || 0 : '', p.judgment?.target ? '대상' : '비대상', v.statusLabel, v.deptName, v.agencyName,
      p.guidancePeriod ? `${p.guidancePeriod.start}~${p.guidancePeriod.end}` : '', (p.visits || []).filter((x) => wf.VISIT_HELD.includes(x.status)).length || '',
      v.cycle?.nextDue || '', v.gaps.filter((g) => !g.reason).length || '', p.judgment?.reason || '']);
  }
  ws.getColumn(7).numFmt = '#,##0';
  ws.getColumn(8).numFmt = '#,##0';
  return { data: new Uint8Array(await wb.xlsx.writeBuffer()), filename: `기술지도_대상공사_${wf.today()}.xlsx` };
}

module.exports = { exportProjects, projectView, meta, dashboard, settlementsView, applySettings, upsertMaster, canSeeAllMail };
