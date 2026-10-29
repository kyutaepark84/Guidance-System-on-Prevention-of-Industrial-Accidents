'use strict';
// 브라우저용 API 처리기: server/index.js 의 REST API를 같은 주소·같은 응답 형태로 브라우저 안에서 처리한다.
const store = require('./db');
const dates = require('./dates');
const wf = require('./workflow');
const views = require('./views');
const userimport = require('./userimport');
const { analyzeContract, analyzeTgContract } = require('./extract');
const settlement = require('./settlement');
const { seed } = require('./seed');

const ALLOWED_EXT = /\.(pdf|docx?|hwpx?|xlsx?|csv|txt|jpe?g|png|gif|zip)$/i;
const MAX_SIZE = 14 * 1024 * 1024;
const pending = new Map();

let platform = null; // { uploadFile(file) -> {assetId,size}, readOnly, mode }
function setPlatform(p) { platform = p; }

const err = (msg, status = 400) => new wf.WfError(msg, status);

function allow(user, ...roles) {
  if (user.role !== 'ADMIN' && !roles.includes(user.role)) throw err('권한이 없습니다.', 403);
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

// 업로드 파일을 첨부 보관함에 올리고 workflow가 쓰는 형태로 바꾼다
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
const MUTATING = /^(POST|PUT|DELETE)$/;
const READONLY_OK = ['/notifications/read', '/contracts/analyze', '/tg-contracts/analyze'];

async function handle(method, url, body, sessionUser) {
  const [path, qs] = url.split('?');
  const q = new URLSearchParams(qs || '');
  const db = store.get();
  const parts = path.split('/').filter(Boolean);

  if (method === 'GET' && path === '/meta') return views.meta({ readOnly: !!(platform && platform.readOnly), storageMode: platform ? platform.mode : 'memory' });
  if (method === 'POST' && path === '/setup/seed') {
    if (db.users.length) throw err('이미 데이터가 있습니다.');
    seed();
    return { ok: true };
  }

  const user = sessionUser && db.users.find((u) => u.id === sessionUser.id && u.active !== false);
  if (!user) throw err('사용자를 선택(로그인)해 주세요.', 401);
  if (MUTATING.test(method) && platform && platform.readOnly && !READONLY_OK.includes(path)) {
    throw err('이 화면은 읽기 전용으로 열렸습니다. 공유 설정에서 편집 권한(참여자 이상)을 받아야 데이터를 바꿀 수 있습니다.', 403);
  }

  let result;
  if (method === 'GET' && path === '/me') result = user;
  else if (method === 'GET' && path === '/dashboard') result = views.dashboard(user);
  else if (method === 'GET' && path === '/projects') {
    result = db.projects.filter((p) => wf.canSee(user, p)).map((p) => views.projectView(p, user)).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  } else if (method === 'GET' && parts[0] === 'projects' && parts.length === 2) {
    result = views.projectView(getProject(parts[1], user), user, true);
  } else if (method === 'POST' && path === '/contracts/analyze') {
    allow(user, 'PURCHASE');
    const { files } = splitForm(body);
    if (!files.length) throw err('계약서 파일을 선택해 주세요.');
    const file = files[0].file;
    checkFile(file);
    let r;
    try { r = await analyzeContract(await bytesOf(file), file.name, { ownerNames: wf.settings().ownerCompanyNames }); } catch (e) {
      r = { fields: {}, evidence: {}, missing: ['name', 'companyName', 'startDate', 'endDate', 'amount'], warning: e.message };
    }
    const token = store.id('tmp');
    pending.set(token, file);
    result = { ...r, token, fileName: file.name };
  } else if (method === 'POST' && path === '/tg-contracts/analyze') {
    allow(user, 'AGENCY');
    const { files } = splitForm(body);
    if (!files.length) throw err('기술지도 계약서 파일을 선택해 주세요.');
    const file = files[0].file;
    checkFile(file);
    try { result = await analyzeTgContract(await bytesOf(file), file.name); } catch (e) {
      result = { fields: {}, evidence: {}, missing: ['contractDate', 'guidanceStart', 'guidanceEnd', 'plannedCount'], warning: e.message };
    }
  } else if (method === 'POST' && path === '/projects') {
    allow(user, 'PURCHASE');
    const { fields, files } = splitForm(body);
    const src = files[0] ? files[0].file : (fields.token && pending.get(fields.token)) || null;
    if (fields.token) pending.delete(fields.token);
    let file = null;
    if (src) [file] = await stage([{ field: 'contract', file: src }]);
    const p = wf.createProject({ ...fields, amount: String(fields.amount ?? '').replace(/[,\s]/g, '') }, user, file);
    store.save();
    result = views.projectView(p, user, true);
  } else if (method === 'POST' && parts[0] === 'projects' && parts[2] === 'actions') {
    const p = getProject(parts[1], user);
    const { fields, files } = splitForm(body);
    if (!wf.ACTIONS[parts[3]]) throw err('알 수 없는 작업입니다.', 404);
    // 권한/상태를 먼저 확인한 뒤에 파일을 올린다(헛 업로드 방지)
    if (!wf.availableActions(p, user).includes(parts[3])) wf.runAction(p, parts[3], { actor: user, body: fields, files: [] });
    const staged = await stage(files);
    wf.runAction(p, parts[3], { actor: user, body: fields, files: staged });
    store.save();
    result = views.projectView(p, user, true);
  } else if (method === 'GET' && parts[0] === 'files') {
    const f = db.files.find((x) => x.id === parts[1]);
    const p = f && db.projects.find((x) => x.id === f.projectId);
    if (!f || (p && !wf.canSee(user, p))) throw err('파일을 찾을 수 없습니다.', 404);
    result = { __file: { record: f } };
  } else if (method === 'GET' && path === '/settlements') {
    result = views.settlementsView(user, String(q.get('year') || wf.today().slice(0, 4)));
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
    const all = q.get('scope') === 'all' && views.canSeeAllMail(user);
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
    result = { __file: await views.exportProjects(user) };
  } else if (parts[0] === 'admin') {
    allow(user);
    const sub = parts[1];
    if (method === 'GET' && sub === 'users' && parts[2] === 'template') {
      return { __file: { data: new Uint8Array(await userimport.usersTemplate()), filename: '담당자_일괄등록_양식.xlsx' } };
    }
    if (method === 'PUT' && sub === 'settings') result = views.applySettings(body || {});
    else if (method === 'POST' && sub === 'advance') {
      db.settings.demoToday = dates.addDays(wf.today(), Number(body.days || 1));
      result = { today: wf.today(), dailyCheck: wf.dailyCheck() };
    } else if (method === 'POST' && sub === 'daily-check') result = wf.dailyCheck();
    else if (method === 'POST' && sub === 'reset') { seed(); result = { ok: true }; }
    else if (method === 'POST' && sub === 'users' && parts[2] === 'upload') {
      const { files } = splitForm(body);
      if (!files.length) throw err('담당자 파일을 선택해 주세요.');
      try { result = await userimport.importUsers(await bytesOf(files[0].file), files[0].file.name); } catch (e) { throw err(e.message); }
    } else if (method === 'POST' && ['users', 'companies', 'agencies', 'departments'].includes(sub)) result = views.upsertMaster(sub, body || {});
    else throw err('알 수 없는 요청입니다.', 404);
    store.save();
  } else {
    throw err('알 수 없는 요청입니다.', 404);
  }
  return result && result.__file ? result : JSON.parse(JSON.stringify(result));
}

module.exports = { handle, setPlatform };
