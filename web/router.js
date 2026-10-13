'use strict';
// 브라우저용 API 처리기: server/index.js 의 REST API를 같은 주소·같은 응답 형태로 브라우저 안에서 처리한다.
const store = require('./db');
const dates = require('./dates');
const wf = require('./workflow');
const notify = require('./notify');
const { analyzeContract } = require('./extract');
const settlement = require('./settlement');
const { seed } = require('./seed');
const ExcelJS = require('exceljs');

const ALLOWED_EXT = /\.(pdf|docx?|hwpx?|xlsx?|csv|txt|jpe?g|png|gif|zip)$/i;
const MAX_SIZE = 14 * 1024 * 1024;
const VISIT_HELD = ['DONE', 'IMPROVEMENT_REQUESTED', 'IMPROVEMENT_SUBMITTED', 'CLOSED_OK'];
const pending = new Map();

let platform = null; // { uploadFile(file) -> {assetId,size}, readOnly }
function setPlatform(p) { platform = p; }

const err = (msg, status = 400) => new wf.WfError(msg, status);
const canSeeAllMail = (u) => ['ADMIN', 'SAFETY', 'PARTNER_MGMT', 'PURCHASE'].includes(u.role);

function allow(user, ...roles) {
  if (user.role !== 'ADMIN' && !roles.includes(user.role)) throw err('권한이 없습니다.', 403);
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
    managerName: db.users.find((u) => u.id === p.managerUserId)?.name || '',
    agencyName: db.agencies.find((a) => a.id === p.agencyId)?.name || '',
    cycle: wf.cycleInfo(p, t),
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

function getProject(id, user) {
  const p = store.get().projects.find((x) => x.id === id);
  if (!p || !wf.canSee(user, p)) throw err('공사를 찾을 수 없습니다.', 404);
  return p;
}

function splitForm(body) {
  if (!(typeof FormData !== 'undefined' && body instanceof FormData)) return { fields: body || {}, files: [] };
  const fields = {};
  const files = [];
  for (const [k, v] of body.entries()) {
    if (typeof v === 'object' && v && 'arrayBuffer' in v) {
      if (!v.size && !v.name) continue;
      files.push({ field: k, file: v });
    } else fields[k] = v;
  }
  return { fields, files };
}

function checkFile(file) {
  if (!ALLOWED_EXT.test(file.name)) throw err(`허용되지 않는 파일 형식입니다: ${file.name}`);
  if (file.size > MAX_SIZE) throw err('DEMO에서는 파일 크기를 14MB 이하로 올려 주세요.');
}

// 업로드 파일을 공유 저장소(첨부 보관함)에 올리고 workflow가 쓰는 형태로 바꾼다
async function stage(files) {
  const out = [];
  for (const { field, file } of files) {
    checkFile(file);
    const up = platform ? await platform.uploadFile(file) : { assetId: null, size: file.size };
    out.push({ buf: up, originalName: file.name, mime: file.type, category: field.startsWith('file_') ? field.slice(5) : undefined });
  }
  return out;
}

const bytesOf = async (file) => new Uint8Array(await file.arrayBuffer());

async function meta() {
  const db = store.get();
  return {
    today: wf.today(),
    realToday: dates.todayReal(),
    status: wf.STATUS,
    visitStatus: wf.VISIT_STATUS,
    roles: notify.ROLE_LABEL,
    actions: Object.fromEntries(Object.entries(wf.ACTIONS).map(([k, a]) => [k, { label: a.label, roles: a.roles }])),
    settings: wf.settings(),
    departments: db.departments,
    companies: db.companies,
    agencies: db.agencies,
    users: db.users.map(({ id, name, role, orgId, title, active }) => ({ id, name, role, orgId, title, active })),
    lastDailyCheck: db.meta.lastDailyCheck || null,
    readOnly: !!(platform && platform.readOnly),
    storageMode: platform ? platform.mode : 'memory',
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
  const endDays = wf.settings().endNoticeDays;
  for (const p of visible) {
    for (const k of wf.tasks(p, t)) if (user.role === 'ADMIN' || k.role === user.role) myTasks.push({ projectId: p.id, projectName: p.name, status: p.status, ...k });
    const c = wf.cycleInfo(p, t);
    if (c && c.level === 'overdue') alerts.push({ level: 'danger', projectId: p.id, projectName: p.name, text: `기술지도 주기 초과 (기한 ${c.nextDue}) — 누락 위험` });
    if (c && c.endIn >= 0 && c.endIn <= endDays && p.status === 'ACTIVE') alerts.push({ level: 'warn', projectId: p.id, projectName: p.name, text: `기술지도 기간 만료 D-${c.endIn} (${p.guidancePeriod.end})` });
    if (c && c.endIn < 0) alerts.push({ level: 'danger', projectId: p.id, projectName: p.name, text: '기술지도 기간 경과 — 종결/연장 미조치' });
    if (p.status === 'MONITORING' && p.judgment?.warning) alerts.push({ level: 'warn', projectId: p.id, projectName: p.name, text: `단가계약 누계 ${(p.judgment.ratio * 100).toFixed(1)}% — 기준 근접` });
    if (p.status === 'DOCS_REQUESTED' && !p.agencyId) alerts.push({ level: 'warn', projectId: p.id, projectName: p.name, text: '기술지도기관 미지정' });
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

async function exportProjects(user) {
  const db = store.get();
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('기술지도 대상 공사');
  ws.columns = [
    ['계약번호', 14], ['공사계약명', 40], ['구분', 10], ['업체명', 18], ['계약시작', 12], ['계약종료', 12], ['계약금액', 15],
    ['누계정산(당해)', 15], ['판정', 10], ['상태', 22], ['담당부서', 12], ['기술지도기관', 26], ['지도기간', 24], ['지도 실시', 10], ['다음 지도기한', 14], ['판정근거', 80],
  ].map(([header, width]) => ({ header, width }));
  ws.getRow(1).font = { bold: true };
  for (const p of db.projects.filter((x) => wf.canSee(user, x))) {
    const v = projectView(p, user);
    ws.addRow([p.contractNo, p.name, p.type === 'UNIT_PRICE' ? '단가계약' : '일반', p.companyName, p.startDate, p.endDate, p.amount,
      p.type === 'UNIT_PRICE' ? p.judgment?.cumulative?.currentYearAmount || 0 : '', p.judgment?.target ? '대상' : '비대상', v.statusLabel, v.deptName, v.agencyName,
      p.guidancePeriod ? `${p.guidancePeriod.start}~${p.guidancePeriod.end}` : '', (p.visits || []).filter((x) => VISIT_HELD.includes(x.status)).length || '',
      v.cycle?.nextDue || '', p.judgment?.reason || '']);
  }
  ws.getColumn(7).numFmt = '#,##0';
  ws.getColumn(8).numFmt = '#,##0';
  return { __file: { data: new Uint8Array(await wb.xlsx.writeBuffer()), filename: `기술지도_대상공사_${wf.today()}.xlsx` } };
}

function adminSettings(s) {
  const db = store.get();
  const num = (k, min) => {
    if (k in s) {
      const n = Number(s[k]);
      if (!(n >= min)) throw err(`${k} 값이 올바르지 않습니다.`);
      db.settings[k] = n;
    }
  };
  num('amountThreshold', 0); num('periodMonths', 0); num('warnRatio', 0); num('endNoticeDays', 0); num('cycleDays', 1); num('cycleRemindDays', 0);
  for (const k of ['notifyEmail', 'notifySms']) if (k in s) db.settings[k] = !!s[k];
  if ('defaultAgencyId' in s) db.settings.defaultAgencyId = s.defaultAgencyId || null;
  if ('demoToday' in s) {
    if (s.demoToday && !dates.isValid(s.demoToday)) throw err('데모 기준일 형식(YYYY-MM-DD)을 확인해 주세요.');
    db.settings.demoToday = s.demoToday || null;
  }
  const r = wf.dailyCheck();
  return { settings: wf.settings(), dailyCheck: r };
}

const MUTATING = /^(POST|PUT|DELETE)$/;

async function handle(method, url, body, sessionUser) {
  const [path, qs] = url.split('?');
  const q = new URLSearchParams(qs || '');
  const db = store.get();
  const parts = path.split('/').filter(Boolean);

  if (method === 'GET' && path === '/meta') return meta();
  if (method === 'POST' && path === '/setup/seed') {
    if (db.users.length) throw err('이미 데이터가 있습니다.');
    seed();
    return { ok: true };
  }

  const user = sessionUser && db.users.find((u) => u.id === sessionUser.id && u.active !== false);
  if (!user) throw err('사용자를 선택(로그인)해 주세요.', 401);
  if (MUTATING.test(method) && platform && platform.readOnly && !(method === 'POST' && path === '/notifications/read')) {
    throw err('이 화면은 읽기 전용으로 열렸습니다. 공유 설정에서 편집 권한(참여자 이상)을 받아야 데이터를 바꿀 수 있습니다.', 403);
  }

  let result;
  if (method === 'GET' && path === '/me') result = user;
  else if (method === 'GET' && path === '/dashboard') result = dashboard(user);
  else if (method === 'GET' && path === '/projects') {
    result = db.projects.filter((p) => wf.canSee(user, p)).map((p) => projectView(p, user)).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  } else if (method === 'GET' && parts[0] === 'projects' && parts.length === 2) {
    result = projectView(getProject(parts[1], user), user, true);
  } else if (method === 'POST' && path === '/contracts/analyze') {
    allow(user, 'PURCHASE');
    const { files } = splitForm(body);
    if (!files.length) throw err('계약서 파일을 선택해 주세요.');
    const file = files[0].file;
    checkFile(file);
    let r;
    try { r = await analyzeContract(await bytesOf(file), file.name); } catch (e) {
      r = { fields: {}, evidence: {}, missing: ['name', 'companyName', 'startDate', 'endDate', 'amount'], warning: e.message };
    }
    const token = store.id('tmp');
    pending.set(token, file);
    result = { ...r, token, fileName: file.name };
  } else if (method === 'POST' && path === '/projects') {
    allow(user, 'PURCHASE');
    const { fields, files } = splitForm(body);
    let src = files[0] ? files[0].file : (fields.token && pending.get(fields.token)) || null;
    if (fields.token) pending.delete(fields.token);
    let file = null;
    if (src) {
      const [st] = await stage([{ field: 'contract', file: src }]);
      file = st;
    }
    const p = wf.createProject({ ...fields, amount: String(fields.amount ?? '').replace(/[,\s]/g, '') }, user, file);
    store.save();
    result = projectView(p, user, true);
  } else if (method === 'POST' && parts[0] === 'projects' && parts[2] === 'actions') {
    const p = getProject(parts[1], user);
    const { fields, files } = splitForm(body);
    // 권한/상태를 먼저 확인한 뒤에 파일을 올린다(헛 업로드 방지)
    const a = wf.ACTIONS[parts[3]];
    if (!a) throw err('알 수 없는 작업입니다.', 404);
    if (!wf.availableActions(p, user).includes(parts[3])) wf.runAction(p, parts[3], { actor: user, body: fields, files: [] }); // 오류 메시지 생성용(여기서 예외)
    const staged = await stage(files);
    wf.runAction(p, parts[3], { actor: user, body: fields, files: staged });
    store.save();
    result = projectView(p, user, true);
  } else if (method === 'GET' && parts[0] === 'files') {
    const f = db.files.find((x) => x.id === parts[1]);
    const p = f && db.projects.find((x) => x.id === f.projectId);
    if (!f || (p && !wf.canSee(user, p))) throw err('파일을 찾을 수 없습니다.', 404);
    result = { __file: { record: f } };
  } else if (method === 'GET' && path === '/settlements') {
    result = settlementsView(user, String(q.get('year') || wf.today().slice(0, 4)));
  } else if (method === 'POST' && path === '/settlements/upload') {
    allow(user, 'PURCHASE', 'PARTNER_MGMT');
    const { files } = splitForm(body);
    if (!files.length) throw err('정산실적 파일을 선택해 주세요.');
    const file = files[0].file;
    let r;
    try { r = await settlement.importSettlements(await bytesOf(file), file.name, user); } catch (e) { throw err(e.message); }
    const changed = [];
    for (const pid of r.affected) {
      const p = db.projects.find((x) => x.id === pid);
      const before = p.status;
      wf.log(p, user, 'SETTLEMENT', '월별 정산실적 반영', file.name);
      wf.applyJudgment(p, user);
      if (before !== p.status) changed.push({ id: p.id, name: p.name, from: wf.STATUS[before]?.label, to: wf.STATUS[p.status]?.label });
    }
    wf.dailyCheck();
    store.save();
    result = { ...r, changed };
  } else if (method === 'GET' && path === '/settlements/template') {
    const buf = await settlement.templateWorkbook(db.projects.filter((p) => wf.canSee(user, p)), wf.today().slice(0, 4));
    result = { __file: { data: new Uint8Array(buf), filename: '단가계약_월별정산실적_양식.xlsx' } };
  } else if (method === 'GET' && path === '/notifications') {
    const all = q.get('scope') === 'all' && canSeeAllMail(user);
    const list = db.notifications.filter((n) => all || n.toUserId === user.id).filter((n) => {
      const p = db.projects.find((x) => x.id === n.projectId);
      return !p || wf.canSee(user, p);
    });
    result = list.slice(-500).reverse().map((n) => ({ ...n, projectName: db.projects.find((p) => p.id === n.projectId)?.name || '' }));
  } else if (method === 'POST' && path === '/notifications/read') {
    const ids = new Set(body.ids || []);
    let changed = false;
    for (const n of db.notifications) if (n.toUserId === user.id && !n.read && (body.all || ids.has(n.id))) { n.read = true; changed = true; }
    if (changed && !(platform && platform.readOnly)) store.save();
    result = { ok: true };
  } else if (method === 'GET' && path === '/export/projects.xlsx') {
    result = await exportProjects(user);
  } else if (parts[0] === 'admin') {
    allow(user);
    const sub = parts[1];
    if (method === 'PUT' && sub === 'settings') result = adminSettings(body || {});
    else if (method === 'POST' && sub === 'advance') {
      db.settings.demoToday = dates.addDays(wf.today(), Number(body.days || 1));
      result = { today: wf.today(), dailyCheck: wf.dailyCheck() };
    } else if (method === 'POST' && sub === 'daily-check') result = wf.dailyCheck();
    else if (method === 'POST' && sub === 'reset') { seed(); result = { ok: true }; }
    else if (method === 'POST' && ['users', 'companies', 'agencies', 'departments'].includes(sub)) {
      const b = body || {};
      if (!b.name) throw err('이름을 입력해 주세요.');
      if (sub === 'users' && !notify.ROLE_LABEL[b.role]) throw err('역할을 선택해 주세요.');
      let rec = b.id && db[sub].find((x) => x.id === b.id);
      if (rec) Object.assign(rec, b);
      else { rec = { ...b, id: store.id(sub.slice(0, 2)), active: true }; db[sub].push(rec); }
      result = rec;
    } else throw err('알 수 없는 요청입니다.', 404);
    store.save();
  } else {
    throw err('알 수 없는 요청입니다.', 404);
  }
  return result && result.__file ? result : JSON.parse(JSON.stringify(result));
}

module.exports = { handle, setPlatform };
