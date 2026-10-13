'use strict';
const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');
const store = require('./db');
const dates = require('./dates');
const wf = require('./workflow');
const notify = require('./notify');
const { analyzeContract } = require('./extract');
const settlement = require('./settlement');
const { seed } = require('./seed');

const PORT = Number(process.env.PORT) || 3000;
const ALLOWED_EXT = /\.(pdf|docx?|hwpx?|xlsx?|csv|txt|jpe?g|png|gif|zip)$/i;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 10 },
  fileFilter(req, file, cb) {
    file.originalname = fixName(file.originalname);
    if (!ALLOWED_EXT.test(file.originalname)) return cb(new wf.WfError(`허용되지 않는 파일 형식입니다: ${file.originalname}`));
    cb(null, true);
  },
});

// 브라우저가 보낸 UTF-8 파일명이 latin1로 해석되는 문제 보정
function fixName(name) {
  const conv = Buffer.from(name, 'latin1').toString('utf8');
  return /[\uFFFD]/.test(conv) ? name : conv;
}

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ───────────── DEMO 인증: 화면에서 선택한 사용자 ID를 헤더로 전달 ─────────────
function auth(req, res, next) {
  const uid = req.get('x-user-id');
  const user = store.get().users.find((u) => u.id === uid && u.active !== false);
  if (!user) return res.status(401).json({ error: '사용자를 선택(로그인)해 주세요.' });
  req.user = user;
  next();
}
const allow = (...roles) => (req, res, next) => (req.user.role === 'ADMIN' || roles.includes(req.user.role) ? next() : res.status(403).json({ error: '권한이 없습니다.' }));
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function projectView(p, user, detail = false) {
  const db = store.get();
  const t = wf.today();
  const allTasks = wf.tasks(p, t);
  const mine = allTasks.filter((x) => user.role === 'ADMIN' || x.role === user.role);
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
    myTasks: mine,
  };
  if (detail) {
    v.files = db.files.filter((f) => f.projectId === p.id).map((f) => ({ ...f, uploaderName: db.users.find((u) => u.id === f.uploadedBy)?.name || '' }));
    v.settlements = db.settlements.filter((s) => s.projectId === p.id).sort((a, b) => a.month.localeCompare(b.month));
    v.notifications = db.notifications.filter((n) => n.projectId === p.id && (canSeeAllMail(user) || n.toUserId === user.id)).slice(-200).reverse();
    v.actions = wf.availableActions(p, user);
  }
  return v;
}

const canSeeAllMail = (u) => ['ADMIN', 'SAFETY', 'PARTNER_MGMT', 'PURCHASE'].includes(u.role);

function getProject(req) {
  const p = store.get().projects.find((x) => x.id === req.params.id);
  if (!p || !wf.canSee(req.user, p)) throw new wf.WfError('공사를 찾을 수 없습니다.', 404);
  return p;
}

const pending = new Map(); // 계약서 분석 후 등록 대기 파일 (token → file)

// ───────────── API ─────────────
const api = express.Router();

api.get('/meta', (req, res) => {
  const db = store.get();
  res.json({
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
  });
});

api.use(auth);

api.get('/me', (req, res) => res.json(req.user));

api.get('/dashboard', (req, res) => {
  const db = store.get();
  const t = wf.today();
  const visible = db.projects.filter((p) => wf.canSee(req.user, p));
  const counts = {};
  for (const p of visible) counts[p.status] = (counts[p.status] || 0) + 1;
  const myTasks = [];
  const alerts = [];
  for (const p of visible) {
    for (const k of wf.tasks(p, t)) {
      if (req.user.role === 'ADMIN' || k.role === req.user.role) myTasks.push({ projectId: p.id, projectName: p.name, status: p.status, ...k });
    }
    const c = wf.cycleInfo(p, t);
    if (c && c.level === 'overdue') alerts.push({ level: 'danger', projectId: p.id, projectName: p.name, text: `기술지도 주기 초과 (기한 ${c.nextDue}) — 누락 위험` });
    if (c && c.endIn >= 0 && c.endIn <= wf.settings().endNoticeDays && p.status === 'ACTIVE') alerts.push({ level: 'warn', projectId: p.id, projectName: p.name, text: `기술지도 기간 만료 D-${c.endIn} (${p.guidancePeriod.end})` });
    if (c && c.endIn < 0) alerts.push({ level: 'danger', projectId: p.id, projectName: p.name, text: `기술지도 기간 경과 — 종결/연장 미조치` });
    if (p.status === 'MONITORING' && p.judgment?.warning) alerts.push({ level: 'warn', projectId: p.id, projectName: p.name, text: `단가계약 누계 ${(p.judgment.ratio * 100).toFixed(1)}% — 기준 근접` });
    if (p.status === 'DOCS_REQUESTED' && !p.agencyId) alerts.push({ level: 'warn', projectId: p.id, projectName: p.name, text: '기술지도기관 미지정' });
  }
  const upcoming = [];
  for (const p of visible) for (const v of p.visits || []) if (v.status === 'SCHEDULED') upcoming.push({ projectId: p.id, projectName: p.name, date: v.plannedDate, time: v.time, round: v.round, agency: db.agencies.find((a) => a.id === p.agencyId)?.name });
  upcoming.sort((a, b) => a.date.localeCompare(b.date));
  const unread = db.notifications.filter((n) => n.toUserId === req.user.id && !n.read && n.channel === 'EMAIL').length;
  res.json({ today: t, counts, total: visible.length, myTasks, alerts, upcoming: upcoming.slice(0, 10), unread, lastDailyCheck: db.meta.lastDailyCheck });
});

api.get('/projects', (req, res) => {
  const db = store.get();
  res.json(db.projects.filter((p) => wf.canSee(req.user, p)).map((p) => projectView(p, req.user)).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')));
});

api.get('/projects/:id', wrap(async (req, res) => {
  res.json(projectView(getProject(req), req.user, true));
}));

// 계약서 분석 (1단계)
api.post('/contracts/analyze', allow('PURCHASE'), upload.single('file'), wrap(async (req, res) => {
  if (!req.file) throw new wf.WfError('계약서 파일을 선택해 주세요.');
  let result;
  try {
    result = await analyzeContract(req.file.buffer, req.file.originalname);
  } catch (e) {
    result = { fields: {}, evidence: {}, missing: ['name', 'companyName', 'startDate', 'endDate', 'amount'], warning: e.message };
  }
  const token = store.id('tmp');
  pending.set(token, { buf: req.file.buffer, originalName: req.file.originalname, mime: req.file.mimetype, at: Date.now() });
  for (const [k, v] of pending) if (Date.now() - v.at > 3600e3) pending.delete(k);
  // 판정 미리보기
  const f = result.fields;
  if (f.startDate && f.endDate && f.amount != null) {
    const { judge } = require('./rules');
    result.preview = judge({ ...f, id: '_preview' }, [], wf.settings(), wf.today());
  }
  res.json({ ...result, token, fileName: req.file.originalname });
}));

// 공사 등록 (2단계: 확인한 정보로 생성)
api.post('/projects', allow('PURCHASE'), upload.single('file'), wrap(async (req, res) => {
  const body = req.body || {};
  let file = null;
  if (req.file) file = { buf: req.file.buffer, originalName: req.file.originalname, mime: req.file.mimetype };
  else if (body.token && pending.has(body.token)) { file = pending.get(body.token); pending.delete(body.token); }
  const p = wf.createProject({ ...body, amount: String(body.amount ?? '').replace(/[,\s]/g, '') }, req.user, file);
  store.save();
  res.json(projectView(p, req.user, true));
}));

api.post('/projects/:id/actions/:action', upload.any(), wrap(async (req, res) => {
  const p = getProject(req);
  const files = (req.files || []).map((f) => ({ buf: f.buffer, originalName: f.originalname, mime: f.mimetype, category: f.fieldname.startsWith('file_') ? f.fieldname.slice(5) : undefined }));
  wf.runAction(p, req.params.action, { actor: req.user, body: req.body || {}, files });
  store.save();
  res.json(projectView(p, req.user, true));
}));

api.get('/files/:id', (req, res) => {
  const db = store.get();
  const f = db.files.find((x) => x.id === req.params.id);
  const p = f && db.projects.find((x) => x.id === f.projectId);
  if (!f || (p && !wf.canSee(req.user, p))) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
  const fp = store.filePath(f);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: '파일이 존재하지 않습니다.' });
  const disp = req.query.inline ? 'inline' : 'attachment';
  res.setHeader('Content-Disposition', `${disp}; filename*=UTF-8''${encodeURIComponent(f.originalName)}`);
  res.type(path.extname(f.originalName) || f.mime);
  res.sendFile(fp);
});

// 단가 정산실적
api.get('/settlements', (req, res) => {
  const db = store.get();
  const t = wf.today();
  const year = String(req.query.year || t.slice(0, 4));
  const units = db.projects.filter((p) => p.type === 'UNIT_PRICE' && wf.canSee(req.user, p));
  res.json({
    year,
    threshold: wf.settings().amountThreshold,
    rows: units.map((p) => {
      const ss = db.settlements.filter((s) => s.projectId === p.id && s.month.startsWith(year));
      const months = {};
      for (const s of ss) months[s.month.slice(5, 7)] = s.amount;
      const cum = ss.reduce((a, s) => a + s.amount, 0);
      return { ...projectView(p, req.user), months, cumulative: cum };
    }),
  });
});

api.post('/settlements/upload', allow('PURCHASE', 'PARTNER_MGMT'), upload.single('file'), wrap(async (req, res) => {
  if (!req.file) throw new wf.WfError('정산실적 파일을 선택해 주세요.');
  let r;
  try {
    r = await settlement.importSettlements(req.file.buffer, req.file.originalname, req.user);
  } catch (e) {
    throw new wf.WfError(e.message);
  }
  const db = store.get();
  const changed = [];
  for (const pid of r.affected) {
    const p = db.projects.find((x) => x.id === pid);
    const before = p.status;
    wf.log(p, req.user, 'SETTLEMENT', '월별 정산실적 반영', req.file.originalname);
    const j = wf.applyJudgment(p, req.user);
    if (!j.becameTarget && p.judgment) p.judgment = { ...p.judgment };
    if (before !== p.status) changed.push({ id: p.id, name: p.name, from: wf.STATUS[before]?.label, to: wf.STATUS[p.status]?.label });
  }
  wf.dailyCheck(); // 누계 주의 안내 등 즉시 점검
  store.save();
  res.json({ ...r, changed });
}));

api.get('/settlements/template', wrap(async (req, res) => {
  const buf = await settlement.templateWorkbook(store.get().projects.filter((p) => wf.canSee(req.user, p)), wf.today().slice(0, 4));
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('단가계약_월별정산실적_양식.xlsx')}`);
  res.type('xlsx').send(Buffer.from(buf));
}));

// 알림(발송함)
api.get('/notifications', (req, res) => {
  const db = store.get();
  const all = req.query.scope === 'all' && canSeeAllMail(req.user);
  const list = db.notifications.filter((n) => all || n.toUserId === req.user.id);
  const visible = list.filter((n) => {
    const p = db.projects.find((x) => x.id === n.projectId);
    return !p || wf.canSee(req.user, p);
  });
  res.json(visible.slice(-500).reverse().map((n) => ({ ...n, projectName: db.projects.find((p) => p.id === n.projectId)?.name || '' })));
});

api.post('/notifications/read', (req, res) => {
  const ids = new Set(req.body.ids || []);
  for (const n of store.get().notifications) if (n.toUserId === req.user.id && (req.body.all || ids.has(n.id))) n.read = true;
  store.save();
  res.json({ ok: true });
});

// 엑셀 내보내기
api.get('/export/projects.xlsx', wrap(async (req, res) => {
  const db = store.get();
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('기술지도 대상 공사');
  ws.columns = [
    ['계약번호', 14], ['공사계약명', 40], ['구분', 10], ['업체명', 18], ['계약시작', 12], ['계약종료', 12], ['계약금액', 15],
    ['누계정산(당해)', 15], ['판정', 10], ['상태', 22], ['담당부서', 12], ['기술지도기관', 26], ['지도기간', 24], ['지도 실시', 10], ['다음 지도기한', 14], ['판정근거', 80],
  ].map(([header, width]) => ({ header, width }));
  ws.getRow(1).font = { bold: true };
  for (const p of db.projects.filter((x) => wf.canSee(req.user, x))) {
    const v = projectView(p, req.user);
    ws.addRow([p.contractNo, p.name, p.type === 'UNIT_PRICE' ? '단가계약' : '일반', p.companyName, p.startDate, p.endDate, p.amount,
      p.type === 'UNIT_PRICE' ? p.judgment?.cumulative?.currentYearAmount || 0 : '', p.judgment?.target ? '대상' : '비대상', v.statusLabel, v.deptName, v.agencyName,
      p.guidancePeriod ? `${p.guidancePeriod.start}~${p.guidancePeriod.end}` : '', (p.visits || []).filter((x) => ['DONE', 'IMPROVEMENT_REQUESTED', 'IMPROVEMENT_SUBMITTED', 'CLOSED_OK'].includes(x.status)).length || '',
      v.cycle?.nextDue || '', p.judgment?.reason || '']);
  }
  ws.getColumn(7).numFmt = '#,##0';
  ws.getColumn(8).numFmt = '#,##0';
  const buf = await wb.xlsx.writeBuffer();
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`기술지도_대상공사_${wf.today()}.xlsx`)}`);
  res.type('xlsx').send(Buffer.from(buf));
}));

// ───────────── 관리자(DEMO 운영) ─────────────
const admin = express.Router();
admin.use(allow('ADMIN'));

admin.put('/settings', (req, res) => {
  const db = store.get();
  const s = req.body || {};
  const num = (k, min) => { if (k in s) { const n = Number(s[k]); if (!(n >= min)) throw new wf.WfError(`${k} 값이 올바르지 않습니다.`); db.settings[k] = n; } };
  num('amountThreshold', 0); num('periodMonths', 0); num('warnRatio', 0); num('endNoticeDays', 0); num('cycleDays', 1); num('cycleRemindDays', 0);
  for (const k of ['notifyEmail', 'notifySms']) if (k in s) db.settings[k] = !!s[k];
  if ('defaultAgencyId' in s) db.settings.defaultAgencyId = s.defaultAgencyId || null;
  if ('demoToday' in s) {
    if (s.demoToday && !dates.isValid(s.demoToday)) throw new wf.WfError('데모 기준일 형식(YYYY-MM-DD)을 확인해 주세요.');
    db.settings.demoToday = s.demoToday || null;
  }
  const r = wf.dailyCheck();
  store.save();
  res.json({ settings: wf.settings(), dailyCheck: r });
});

admin.post('/advance', (req, res) => {
  const db = store.get();
  const n = Number(req.body.days || 1);
  db.settings.demoToday = dates.addDays(wf.today(), n);
  const r = wf.dailyCheck();
  res.json({ today: wf.today(), dailyCheck: r });
});

admin.post('/daily-check', (req, res) => res.json(wf.dailyCheck()));

admin.post('/reset', (req, res) => {
  seed();
  res.json({ ok: true });
});

for (const kind of ['users', 'companies', 'agencies', 'departments']) {
  admin.post(`/${kind}`, (req, res) => {
    const db = store.get();
    const b = req.body || {};
    if (!b.name) throw new wf.WfError('이름을 입력해 주세요.');
    if (kind === 'users' && !notify.ROLE_LABEL[b.role]) throw new wf.WfError('역할을 선택해 주세요.');
    let rec = b.id && db[kind].find((x) => x.id === b.id);
    if (rec) Object.assign(rec, b);
    else { rec = { ...b, id: store.id(kind.slice(0, 2)), active: true }; db[kind].push(rec); }
    store.save();
    res.json(rec);
  });
}

api.use('/admin', admin);
app.use('/api', api);

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  const status = err.status || (err instanceof multer.MulterError ? 400 : 500);
  if (status >= 500) console.error(err);
  const msg = err instanceof multer.MulterError ? (err.code === 'LIMIT_FILE_SIZE' ? '파일 크기는 20MB 이하여야 합니다.' : err.message) : err.message;
  res.status(status).json({ error: msg || '오류가 발생했습니다.' });
});

function start() {
  const { fresh } = store.load();
  if (fresh || process.env.TG_RESEED === '1') {
    seed();
    console.log('DEMO 데이터를 생성했습니다.');
  }
  // 일일 점검: 기동 시 + 매시간(기준일이 바뀐 경우에만 재실행)
  wf.dailyCheck();
  setInterval(() => {
    const last = store.get().meta.lastDailyCheck;
    if (!last || last.date !== wf.today()) wf.dailyCheck();
  }, 3600e3).unref();
  return app.listen(PORT, () => console.log(`재해예방 기술지도 관리시스템(DEMO): http://localhost:${PORT}`));
}

if (require.main === module) start();

module.exports = { app, start };
