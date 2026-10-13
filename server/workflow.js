'use strict';
// 재해예방 기술지도 업무 흐름(상태 머신)
//
//  [공사 등록(구매)] ─자동판정─┬─ 대상 아님(일반) ─────────────────────────── NOT_TARGET
//                             ├─ 대상 아님(단가, 누계관리) ── 누계 1억 도달 ─┐  MONITORING
//                             └─ 대상 ──────────────────────────────────────┤
//                                                                            ▼
//  DOCS_REQUESTED (협력업체: 관련자료 제출) ◀── 보완요청 ── DOCS_SUBMITTED (기관: 검토/기술지도 계약서 제출)
//                                                              │
//                                                              ▼
//  ACTIVE (기술지도 진행: 작업일 지정 → 지도일 선택 → 결과 제출 → (보완 → 개선결과 → 확인))
//      │  ├─ D-15 자동안내 / 15일 주기 점검(스케줄러)
//      │  └─ 연장 → EXTENSION (구매: 계약서 갱신 → 협력업체: 관련서류 → 기관: 추가계약서) → ACTIVE
//      └─ 종결(협력업체 관리부서) → CLOSED
const store = require('./db');
const dates = require('./dates');
const { judge, DEFAULT_RULES, won } = require('./rules');
const notify = require('./notify');

const STATUS = {
  NOT_TARGET: { label: '대상 아님', step: 1, color: 'gray' },
  MONITORING: { label: '누계 관리(대상 아님)', step: 1, color: 'blue' },
  DOCS_REQUESTED: { label: '관련자료 제출 대기', step: 3, color: 'orange' },
  DOCS_SUBMITTED: { label: '자료검토·계약서 제출 대기', step: 4, color: 'orange' },
  ACTIVE: { label: '기술지도 진행중', step: 5, color: 'green' },
  EXTENSION: { label: '기간 연장 진행중', step: 6, color: 'purple' },
  CLOSED: { label: '종결', step: 7, color: 'gray' },
};

const VISIT_STATUS = {
  SCHEDULED: '지도 예정',
  DONE: '지도 완료',
  IMPROVEMENT_REQUESTED: '보완 요구(개선결과 제출 대기)',
  IMPROVEMENT_SUBMITTED: '개선결과 검토 대기',
  CLOSED_OK: '보완 완료',
  CANCELED: '취소',
};
const VISIT_HELD = ['DONE', 'IMPROVEMENT_REQUESTED', 'IMPROVEMENT_SUBMITTED', 'CLOSED_OK'];

const DEFAULT_SETTINGS = {
  ...DEFAULT_RULES,
  endNoticeDays: 15, // 기술지도 기간 만료 D-15 안내
  cycleDays: 15, // 기술지도 주기(15일에 1회)
  cycleRemindDays: 10, // 직전 지도 후 N일 경과 시 일정 미지정이면 안내
  demoToday: null, // 데모 기준일(시간 경과 시뮬레이션)
  notifyEmail: true,
  notifySms: true,
  defaultAgencyId: null,
  docTypes: [
    { key: 'CONTRACT', label: '해당공사 공사 계약서', required: true },
    { key: 'INSURANCE', label: '산재보험 가입증명서', required: true },
    { key: 'BIZREG', label: '사업자 등록증', required: true },
    { key: 'ETC', label: '기타(공정표, 착공계 등)', required: false },
  ],
};

class WfError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

function settings() {
  const db = store.get();
  return { ...DEFAULT_SETTINGS, ...(db.settings || {}) };
}

function today() {
  const s = settings();
  return s.demoToday && dates.isValid(s.demoToday) ? s.demoToday : dates.todayReal();
}

function log(p, actor, action, label, note) {
  p.history = p.history || [];
  p.history.push({
    at: new Date().toISOString(),
    date: today(),
    userId: actor ? actor.id : null,
    userName: actor ? actor.name : '시스템',
    role: actor ? actor.role : 'SYSTEM',
    action,
    label,
    note: note || '',
  });
}

const SYSTEM = { id: 'system', name: '시스템(자동)', role: 'SYSTEM' };

// ───────────────────────── 판정 & 대상 전환 ─────────────────────────

function applyJudgment(p, actor) {
  const db = store.get();
  const t = today();
  const s = settings();
  const j = judge(p, db.settlements, s, t);
  p.judgment = { ...j, judgedAt: t };
  const preTarget = !p.status || p.status === 'NOT_TARGET' || p.status === 'MONITORING';
  if (!preTarget) return { becameTarget: false };

  if (!j.target) {
    const next = p.type === 'UNIT_PRICE' ? 'MONITORING' : 'NOT_TARGET';
    if (p.status !== next) {
      p.status = next;
      log(p, actor || SYSTEM, 'JUDGED', '대상여부 판정', j.reason);
    }
    return { becameTarget: false };
  }

  // 대상 전환
  const start = j.basis === 'UNIT_CUMULATIVE' ? (t > p.startDate ? t : p.startDate) : p.startDate;
  p.guidancePeriod = { start, end: p.endDate };
  p.targetAt = t;
  p.status = 'DOCS_REQUESTED';
  if (!p.agencyId && s.defaultAgencyId) p.agencyId = s.defaultAgencyId;
  log(p, actor || SYSTEM, 'JUDGED', '기술지도 대상 판정', j.reason);
  const r = sendTargetNotice(p);
  log(p, SYSTEM, 'NOTIFY', '기술지도 대상 자동 안내 발송', `수신 ${r.count}명: ${r.recipients.join(', ')}${r.missingRoles.length ? ` / 수신자 없음: ${r.missingRoles.map((x) => notify.ROLE_LABEL[x]).join(', ')}` : ''}`);
  return { becameTarget: true };
}

function sendTargetNotice(p) {
  const docList = settings().docTypes.map((d) => `${d.label}${d.required ? '' : '(선택)'}`).join(', ');
  return notify.send(p, 'TARGET_NOTICE', ['PARTNER_MGMT', 'CONTRACTOR', 'AGENCY', 'SAFETY'], {
    subject: '재해예방 기술지도 대상 공사 안내',
    body: (role) => {
      const head = `아래 공사가 재해예방 기술지도 대상으로 판정되었습니다.\n판정근거: ${p.judgment.reason}`;
      if (role === 'CONTRACTOR') return `${head}\n\n[협력업체 조치사항]\n관리시스템에 기술지도 관련 자료를 Upload 하여 제출해 주시기 바랍니다.\n - 제출자료: ${docList}`;
      if (role === 'AGENCY') return `${head}\n\n[기술지도기관 조치사항]\n협력업체 자료 제출 후, 재해예방 기술지도 계약서를 관리시스템에 Upload 하여 제출해 주시기 바랍니다.`;
      return `${head}\n\n협력업체 자료 제출 및 기술지도기관 계약서 제출 진행 상황을 관리시스템에서 확인해 주시기 바랍니다.`;
    },
    sms: (role) => role === 'CONTRACTOR' ? '기술지도 대상 공사 - 관련자료 시스템 제출 요망'
      : role === 'AGENCY' ? '기술지도 대상 공사 - 기술지도 계약서 시스템 제출 요망' : '재해예방 기술지도 대상 공사 판정',
  }, today());
}

// ───────────────────────── 공사 등록 ─────────────────────────

function validateProjectFields(f) {
  const errs = [];
  if (!f.name) errs.push('공사계약명');
  if (!f.companyId && !f.companyName) errs.push('업체명');
  if (!dates.isValid(f.startDate)) errs.push('계약 시작일');
  if (!dates.isValid(f.endDate)) errs.push('계약 종료일');
  if (!(Number(f.amount) >= 0) || f.amount === '' || f.amount == null) errs.push('계약금액');
  if (errs.length) throw new WfError(`필수 항목을 확인해 주세요: ${errs.join(', ')}`);
  if (f.startDate > f.endDate) throw new WfError('계약 종료일이 시작일보다 빠릅니다.');
  if (!['GENERAL', 'UNIT_PRICE'].includes(f.type)) throw new WfError('공사 구분(일반/단가계약)을 선택해 주세요.');
}

function resolveCompany(f) {
  const db = store.get();
  if (f.companyId) {
    const c = db.companies.find((x) => x.id === f.companyId);
    if (!c) throw new WfError('등록되지 않은 협력업체입니다.');
    return c;
  }
  const norm = (s) => String(s).replace(/\(주\)|㈜|주식회사|\s/g, '');
  let c = db.companies.find((x) => norm(x.name) === norm(f.companyName));
  if (!c) {
    c = { id: store.id('co'), name: f.companyName.trim(), bizNo: '', phone: '', email: '' };
    db.companies.push(c);
  }
  return c;
}

function createProject(fields, actor, contractFile) {
  const db = store.get();
  validateProjectFields(fields);
  const company = resolveCompany(fields);
  const dup = fields.contractNo && db.projects.find((p) => p.contractNo === fields.contractNo);
  if (dup) throw new WfError(`이미 등록된 계약번호입니다: ${fields.contractNo} (${dup.name})`);
  const p = {
    id: store.id('p'),
    contractNo: fields.contractNo || '',
    name: fields.name.trim(),
    type: fields.type,
    companyId: company.id,
    companyName: company.name,
    startDate: fields.startDate,
    endDate: fields.endDate,
    amount: Math.round(Number(fields.amount)),
    deptId: fields.deptId || null,
    managerUserId: fields.managerUserId || null,
    agencyId: fields.agencyId || null,
    workPlace: fields.workPlace || '',
    status: null,
    workDays: [],
    visits: [],
    extensions: [],
    flags: {},
    history: [],
    createdAt: new Date().toISOString(),
    createdBy: actor.id,
  };
  db.projects.push(p);
  log(p, actor, 'CREATED', '공사 정보 등록', contractFile ? `계약서: ${contractFile.originalName}` : '');
  if (contractFile) {
    const rec = store.storeFile(contractFile.buf, { originalName: contractFile.originalName, mime: contractFile.mime, projectId: p.id, category: 'PURCHASE_CONTRACT', ref: 'REGISTER', uploadedBy: actor.id });
    p.contractFileId = rec.id;
  }
  applyJudgment(p, SYSTEM);
  return p;
}

// ───────────────────────── 권한 ─────────────────────────

function canSee(user, p) {
  if (!user) return false;
  if (user.role === 'CONTRACTOR') return p.companyId === user.orgId;
  if (user.role === 'AGENCY') return !!p.agencyId && p.agencyId === user.orgId;
  return true;
}

function checkActor(actor, p, roles) {
  if (actor.role === 'ADMIN') return;
  if (!roles.includes(actor.role)) {
    throw new WfError(`이 작업은 ${roles.map((r) => notify.ROLE_LABEL[r]).join('/')}만 수행할 수 있습니다.`, 403);
  }
  if (actor.role === 'CONTRACTOR' && p.companyId !== actor.orgId) throw new WfError('해당 공사의 협력업체 사용자만 수행할 수 있습니다.', 403);
  if (actor.role === 'AGENCY' && p.agencyId !== actor.orgId) throw new WfError('해당 공사에 지정된 기술지도기관만 수행할 수 있습니다.', 403);
}

function checkStatus(p, statuses) {
  if (!statuses.includes(p.status)) {
    throw new WfError(`현재 상태(${STATUS[p.status]?.label || p.status})에서는 수행할 수 없는 작업입니다.`);
  }
}

// ───────────────────────── 유틸 ─────────────────────────

function saveFiles(p, files, actor, category, ref) {
  return (files || []).map((f) => store.storeFile(f.buf, {
    originalName: f.originalName, mime: f.mime, projectId: p.id,
    category: f.category || category, ref, uploadedBy: actor.id,
  }));
}

function ALL4() { return ['PARTNER_MGMT', 'CONTRACTOR', 'AGENCY', 'SAFETY']; }

function findVisit(p, visitId) {
  const v = (p.visits || []).find((x) => x.id === visitId);
  if (!v) throw new WfError('기술지도 일정을 찾을 수 없습니다.');
  return v;
}

function lastHeldDate(p) {
  const held = (p.visits || []).filter((v) => VISIT_HELD.includes(v.status) && v.actualDate).map((v) => v.actualDate).sort();
  return held.length ? held[held.length - 1] : null;
}

// 15일 주기 점검 정보
function cycleInfo(p, t = today()) {
  if (!['ACTIVE', 'EXTENSION'].includes(p.status) || !p.guidancePeriod) return null;
  const s = settings();
  const last = lastHeldDate(p);
  const anchor = last || p.guidancePeriod.start;
  const nextDue = dates.addDays(anchor, s.cycleDays);
  const upcoming = (p.visits || []).filter((v) => v.status === 'SCHEDULED').map((v) => v.plannedDate).sort()[0] || null;
  const daysLeft = dates.diffDays(t, nextDue);
  let level = 'ok';
  if (t > p.guidancePeriod.end) level = 'expired';
  else if (daysLeft < 0 && !(upcoming && upcoming <= t)) level = 'overdue';
  else if (!upcoming && daysLeft <= s.cycleDays - s.cycleRemindDays) level = 'warn';
  else if (upcoming && upcoming > nextDue) level = 'warn';
  return { last, anchor, nextDue, daysLeft, upcoming, level, endIn: dates.diffDays(t, p.guidancePeriod.end) };
}

// 현재 해야 할 일(Ball-in-court)
function tasks(p, t = today()) {
  const out = [];
  const add = (role, label, urgent = false) => out.push({ role, label, urgent });
  const s = settings();
  switch (p.status) {
    case 'MONITORING':
      if (p.judgment && p.judgment.warning) add('PARTNER_MGMT', '단가계약 누계 주의 — 작업 세분화 또는 기술지도 계약 준비 검토', true);
      break;
    case 'DOCS_REQUESTED':
      if (!p.agencyId) add('PARTNER_MGMT', '기술지도기관 지정 필요', true);
      add('CONTRACTOR', p.supplementNote ? '보완 요청된 관련자료 재제출' : '기술지도 관련자료 Upload 및 제출');
      break;
    case 'DOCS_SUBMITTED':
      add('AGENCY', '관련자료 검토 및 기술지도 계약서 Upload 제출');
      break;
    case 'ACTIVE':
    case 'EXTENSION': {
      if (!p.safetyCheck) add('SAFETY', '기술지도 계약서 및 노동부 제출 여부 확인');
      const futureWork = (p.workDays || []).filter((d) => d >= t);
      const scheduled = (p.visits || []).filter((v) => v.status === 'SCHEDULED');
      if (!futureWork.length && !scheduled.length) add('CONTRACTOR', '월별 작업일자 지정');
      if (futureWork.length && !scheduled.length) add('AGENCY', '작업일자 중 기술지도 일자 선택');
      for (const v of scheduled) if (v.plannedDate <= t) add('AGENCY', `기술지도 결과 제출 (${v.plannedDate})`, true);
      for (const v of p.visits || []) {
        if (v.status === 'IMPROVEMENT_REQUESTED') add('CONTRACTOR', `미비점 보완 및 개선결과 보고 (${v.actualDate} 지도분)`, true);
        if (v.status === 'IMPROVEMENT_SUBMITTED') add('AGENCY', `개선결과 검토 (${v.actualDate} 지도분)`);
      }
      const c = cycleInfo(p, t);
      if (c && c.level === 'overdue') add('AGENCY', `기술지도 주기(${s.cycleDays}일) 경과 — 즉시 지도 필요 (기한 ${c.nextDue})`, true);
      if (p.status === 'ACTIVE' && c && c.endIn <= s.endNoticeDays) {
        add('PARTNER_MGMT', c.endIn < 0 ? '기술지도 기간 만료 — 종결 또는 연장 조치' : `기간 만료 D-${c.endIn} — 현장 완료 시 종결, 필요 시 연장`, true);
      }
      if (p.status === 'EXTENSION' && p.extension) {
        const st = p.extension.step;
        if (st === 'PURCHASE') add('PURCHASE', '연장 계약서 갱신 Upload' + (p.type === 'UNIT_PRICE' ? ' (가계약서/본계약서)' : ''), true);
        if (st === 'CONTRACTOR') add('CONTRACTOR', '연장 관련서류 제출 (갱신계약서/납품연기원, 산재가입증명서 갱신)', true);
        if (st === 'AGENCY') add('AGENCY', '기술지도 추가계약서 제출', true);
      }
      break;
    }
    default:
  }
  return out;
}

// ───────────────────────── 액션 ─────────────────────────

const ACTIONS = {
  update_info: {
    label: '공사 정보 수정',
    roles: ['PURCHASE', 'PARTNER_MGMT'],
    statuses: ['NOT_TARGET', 'MONITORING', 'DOCS_REQUESTED', 'DOCS_SUBMITTED'],
    run(p, { actor, body }) {
      const f = { ...p, ...pick(body, ['name', 'contractNo', 'type', 'startDate', 'endDate', 'amount', 'workPlace']) };
      if (body.companyName && body.companyName !== p.companyName) { f.companyId = null; f.companyName = body.companyName; }
      validateProjectFields(f);
      const c = resolveCompany(f);
      Object.assign(p, pick(f, ['name', 'contractNo', 'type', 'startDate', 'endDate', 'workPlace']), { amount: Math.round(Number(f.amount)), companyId: c.id, companyName: c.name });
      if (p.guidancePeriod && p.status !== 'NOT_TARGET' && p.status !== 'MONITORING') p.guidancePeriod.end = p.endDate;
      log(p, actor, 'UPDATED', '공사 정보 수정', body.note);
      applyJudgment(p, actor);
    },
  },

  assign: {
    label: '담당/기술지도기관 지정',
    roles: ['PARTNER_MGMT', 'SAFETY', 'PURCHASE'],
    statuses: Object.keys(STATUS).filter((s) => s !== 'CLOSED'),
    run(p, { actor, body }) {
      const db = store.get();
      const before = p.agencyId;
      if ('deptId' in body) p.deptId = body.deptId || null;
      if ('managerUserId' in body) p.managerUserId = body.managerUserId || null;
      if ('agencyId' in body) {
        if (body.agencyId && !db.agencies.find((a) => a.id === body.agencyId)) throw new WfError('등록되지 않은 기술지도기관입니다.');
        if (before && body.agencyId !== before && ['ACTIVE', 'EXTENSION'].includes(p.status)) throw new WfError('기술지도 진행 중에는 기관을 변경할 수 없습니다.');
        p.agencyId = body.agencyId || null;
      }
      const ag = db.agencies.find((a) => a.id === p.agencyId);
      log(p, actor, 'ASSIGNED', '담당/기술지도기관 지정', ag ? `기술지도기관: ${ag.name}` : '');
      if (p.agencyId && p.agencyId !== before && p.status === 'DOCS_REQUESTED') {
        notify.send(p, 'AGENCY_ASSIGNED', ['AGENCY'], {
          subject: '재해예방 기술지도 기관 지정 안내',
          body: `귀 기관이 아래 공사의 재해예방 기술지도 기관으로 지정되었습니다.\n협력업체 자료 제출 후 기술지도 계약서를 관리시스템에 Upload 하여 제출해 주시기 바랍니다.`,
          sms: '기술지도기관 지정 - 기술지도 계약서 시스템 제출 요망',
        }, today());
      }
    },
  },

  upload_docs: {
    label: '관련자료 Upload',
    roles: ['CONTRACTOR'],
    statuses: ['DOCS_REQUESTED'],
    run(p, { actor, files }) {
      if (!files || !files.length) throw new WfError('업로드할 파일을 선택해 주세요.');
      const keys = settings().docTypes.map((d) => d.key);
      for (const f of files) if (!keys.includes(f.category)) f.category = 'ETC';
      const recs = saveFiles(p, files, actor, 'ETC', 'DOCS');
      log(p, actor, 'DOCS_UPLOADED', '관련자료 Upload', recs.map((r) => r.originalName).join(', '));
    },
  },

  submit_docs: {
    label: '관련자료 제출',
    roles: ['CONTRACTOR'],
    statuses: ['DOCS_REQUESTED'],
    run(p, { actor, body }) {
      const db = store.get();
      const have = new Set(db.files.filter((f) => f.projectId === p.id && f.ref === 'DOCS').map((f) => f.category));
      const missing = settings().docTypes.filter((d) => d.required && !have.has(d.key)).map((d) => d.label);
      if (missing.length) throw new WfError(`필수 자료가 누락되었습니다: ${missing.join(', ')}`);
      if (!p.agencyId) throw new WfError('기술지도기관이 지정되지 않았습니다. 협력업체 관리부서에 기관 지정을 요청해 주세요.');
      p.status = 'DOCS_SUBMITTED';
      p.docsSubmittedAt = today();
      p.supplementNote = null;
      log(p, actor, 'DOCS_SUBMITTED', '기술지도기관에 관련자료 제출', body.note);
      notify.send(p, 'DOCS_SUBMITTED', ['AGENCY', 'PARTNER_MGMT'], {
        subject: '협력업체 관련자료 제출 완료',
        body: (role) => role === 'AGENCY'
          ? '협력업체가 기술지도 관련자료를 제출하였습니다.\n자료 검토 후 기술지도 계약서를 관리시스템에 Upload 하여 제출해 주시기 바랍니다. (보완 필요 시 시스템에서 보완요청)'
          : '협력업체가 기술지도 관련자료를 제출하였습니다. 기술지도기관 검토 중입니다.',
        sms: (role) => role === 'AGENCY' ? '관련자료 제출됨 - 검토 및 기술지도 계약서 제출 요망' : '협력업체 관련자료 제출 완료',
      }, today());
    },
  },

  request_supplement: {
    label: '자료 보완요청',
    roles: ['AGENCY'],
    statuses: ['DOCS_SUBMITTED'],
    run(p, { actor, body }) {
      if (!body.note) throw new WfError('보완 요청 사항을 입력해 주세요.');
      p.status = 'DOCS_REQUESTED';
      p.supplementNote = body.note;
      log(p, actor, 'SUPPLEMENT', '관련자료 보완 요청', body.note);
      notify.send(p, 'SUPPLEMENT_REQUESTED', ['CONTRACTOR', 'PARTNER_MGMT'], {
        subject: '기술지도 관련자료 보완 요청',
        body: `기술지도기관에서 제출자료 보완을 요청하였습니다.\n보완 요청사항: ${body.note}\n\n관리시스템에서 자료를 보완하여 재제출해 주시기 바랍니다.`,
        sms: '기술지도 관련자료 보완 요청 - 시스템 확인 요망',
      }, today());
    },
  },

  submit_tg_contract: {
    label: '기술지도 계약서 제출',
    roles: ['AGENCY'],
    statuses: ['DOCS_SUBMITTED'],
    run(p, { actor, body, files }) {
      if (!files || !files.length) throw new WfError('기술지도 계약서 파일을 첨부해 주세요.');
      const gs = body.guidanceStart || p.guidancePeriod.start;
      const ge = body.guidanceEnd || p.guidancePeriod.end;
      if (!dates.isValid(gs) || !dates.isValid(ge) || gs > ge) throw new WfError('기술지도 기간을 확인해 주세요.');
      saveFiles(p, files, actor, 'TG_CONTRACT', 'TG_CONTRACT');
      p.guidancePeriod = { start: gs, end: ge };
      p.tgContract = {
        contractDate: body.contractDate || today(),
        contractNo: body.tgContractNo || '',
        plannedCount: Number(body.plannedCount) || Math.max(1, Math.ceil((dates.diffDays(gs, ge) + 1) / settings().cycleDays)),
        moelSubmittedDate: body.moelSubmittedDate || '',
      };
      p.status = 'ACTIVE';
      log(p, actor, 'TG_CONTRACT', '기술지도 계약서 제출 → 기술지도 개시', `지도기간 ${gs} ~ ${ge}, 예정 ${p.tgContract.plannedCount}회`);
      notify.send(p, 'GUIDANCE_STARTED', ALL4(), {
        subject: '재해예방 기술지도 계약 체결 및 개시 안내',
        body: (role) => {
          const base = `기술지도기관이 기술지도 계약서를 제출하여 기술지도가 개시되었습니다.\n기술지도 기간: ${gs} ~ ${ge} (예정 ${p.tgContract.plannedCount}회, ${settings().cycleDays}일 1회 이상)`;
          if (role === 'CONTRACTOR') return `${base}\n\n[협력업체 조치사항] 관리시스템에 월별 작업일자를 지정해 주시기 바랍니다.`;
          if (role === 'SAFETY') return `${base}\n\n[안전보건환경부서] 기술지도 계약서 및 노동부 제출 여부를 확인해 주시기 바랍니다.`;
          return base;
        },
        sms: (role) => role === 'CONTRACTOR' ? '기술지도 개시 - 월별 작업일자 지정 요망' : '재해예방 기술지도 개시',
      }, today());
    },
  },

  safety_check: {
    label: '계약서·노동부 제출 확인',
    roles: ['SAFETY'],
    statuses: ['ACTIVE', 'EXTENSION', 'CLOSED'],
    run(p, { actor, body }) {
      p.safetyCheck = { at: today(), by: actor.name, note: body.note || '' };
      log(p, actor, 'SAFETY_CHECK', '기술지도 계약서·노동부 제출 확인', body.note);
    },
  },

  set_work_days: {
    label: '월별 작업일자 지정',
    roles: ['CONTRACTOR', 'PARTNER_MGMT'],
    statuses: ['ACTIVE', 'EXTENSION'],
    run(p, { actor, body }) {
      const month = body.month;
      if (!/^\d{4}-\d{2}$/.test(month || '')) throw new WfError('대상 월을 선택해 주세요.');
      const days = String(body.days || '').split(',').map((x) => x.trim()).filter(Boolean);
      for (const d of days) {
        if (!dates.isValid(d) || !d.startsWith(month)) throw new WfError(`작업일자 형식 오류: ${d}`);
        if (d < p.guidancePeriod.start || d > p.guidancePeriod.end) throw new WfError(`작업일자 ${d}가 기술지도 기간(${p.guidancePeriod.start} ~ ${p.guidancePeriod.end}) 밖입니다.`);
      }
      p.workDays = [...(p.workDays || []).filter((d) => !d.startsWith(month)), ...days].sort();
      log(p, actor, 'WORK_DAYS', `${month} 작업일자 지정`, `${days.length}일: ${days.map((d) => d.slice(8)).join(', ')}일`);
      if (days.length) {
        notify.send(p, 'WORK_DAYS', ['AGENCY'], {
          subject: `${month} 작업일자 지정 안내`,
          body: `협력업체가 ${month} 작업일자(${days.length}일)를 지정하였습니다.\n작업일: ${days.join(', ')}\n\n작업일자 중 기술지도 가능 일자를 관리시스템에서 선택해 주시기 바랍니다.`,
          sms: `${month} 작업일 지정 - 기술지도 일자 선택 요망`,
        }, today());
      }
    },
  },

  schedule_visit: {
    label: '기술지도 일자 선택',
    roles: ['AGENCY'],
    statuses: ['ACTIVE', 'EXTENSION'],
    run(p, { actor, body }) {
      const d = body.date;
      if (!dates.isValid(d)) throw new WfError('기술지도 일자를 선택해 주세요.');
      if (!(p.workDays || []).includes(d)) throw new WfError('협력업체가 지정한 작업일자 중에서 선택해 주세요.');
      if ((p.visits || []).some((v) => v.plannedDate === d && v.status !== 'CANCELED')) throw new WfError('이미 같은 날짜에 기술지도 일정이 있습니다.');
      const v = { id: store.id('v'), round: (p.visits || []).filter((x) => x.status !== 'CANCELED').length + 1, plannedDate: d, time: body.time || '', inspector: body.inspector || actor.name, status: 'SCHEDULED', createdAt: today() };
      p.visits = [...(p.visits || []), v];
      log(p, actor, 'VISIT_SCHEDULED', `${v.round}회차 기술지도 일자 지정`, `${d} ${v.time} / 지도요원 ${v.inspector}`);
      notify.send(p, 'VISIT_SCHEDULED', ALL4(), {
        subject: `${v.round}회차 기술지도 지정일 안내`,
        body: `재해예방 기술지도 일자가 지정되었습니다.\n - 지도일자: ${d} ${v.time}\n - 지도요원: ${v.inspector}\n - 회차: ${v.round}회차\n\n협력업체는 현장 기술지도에 협조해 주시기 바랍니다.`,
        sms: `기술지도 지정일 ${d} ${v.time}`,
      }, today());
    },
  },

  cancel_visit: {
    label: '기술지도 일정 취소',
    roles: ['AGENCY'],
    statuses: ['ACTIVE', 'EXTENSION'],
    run(p, { actor, body }) {
      const v = findVisit(p, body.visitId);
      if (v.status !== 'SCHEDULED') throw new WfError('예정 상태인 일정만 취소할 수 있습니다.');
      v.status = 'CANCELED';
      v.cancelNote = body.note || '';
      log(p, actor, 'VISIT_CANCELED', `${v.round}회차 기술지도 일정 취소`, `${v.plannedDate} ${body.note || ''}`);
      notify.send(p, 'VISIT_CANCELED', ALL4(), {
        subject: '기술지도 일정 취소 안내',
        body: `${v.plannedDate} 기술지도 일정이 취소되었습니다.\n사유: ${body.note || '-'}\n재지정 일정은 추후 안내됩니다.`,
        sms: `기술지도 ${v.plannedDate} 일정 취소`,
      }, today());
    },
  },

  submit_result: {
    label: '기술지도 결과 제출',
    roles: ['AGENCY'],
    statuses: ['ACTIVE', 'EXTENSION'],
    run(p, { actor, body, files }) {
      const v = findVisit(p, body.visitId);
      if (v.status !== 'SCHEDULED') throw new WfError('예정 상태인 일정에만 결과를 제출할 수 있습니다.');
      const ad = body.actualDate || v.plannedDate;
      if (!dates.isValid(ad)) throw new WfError('실제 지도일자를 확인해 주세요.');
      if (ad > today()) throw new WfError('미래 일자의 결과는 제출할 수 없습니다. (현장 방문 후 작성)');
      if (!body.summary) throw new WfError('기술지도 내용을 입력해 주세요.');
      const hasFindings = body.hasFindings === 'true' || body.hasFindings === true || body.hasFindings === 'on';
      if (hasFindings && !body.findings) throw new WfError('보완 요구사항을 입력해 주세요.');
      const recs = saveFiles(p, files, actor, 'TG_RESULT', v.id);
      Object.assign(v, {
        actualDate: ad,
        summary: body.summary,
        findings: hasFindings ? (body.findings || '') : '',
        improveDue: hasFindings ? (body.improveDue || dates.addDays(ad, 7)) : '',
        moelReported: body.moelReported === 'true' || body.moelReported === 'on',
        resultFiles: recs.map((r) => r.id),
        resultAt: today(),
        status: hasFindings ? 'IMPROVEMENT_REQUESTED' : 'DONE',
      });
      log(p, actor, 'RESULT', `${v.round}회차 기술지도 결과 제출`, hasFindings ? `보완요구: ${v.findings}` : '보완사항 없음');
      notify.send(p, 'RESULT_SUBMITTED', ALL4(), {
        subject: `${v.round}회차 기술지도 결과 ${hasFindings ? '(보완 요구)' : ''}`,
        body: (role) => {
          let b = `${ad} ${v.round}회차 재해예방 기술지도 결과가 제출되었습니다.\n지도내용: ${v.summary}`;
          if (hasFindings) {
            b += `\n\n[미비점 및 개선요구 사항]\n${v.findings}\n개선 기한: ${v.improveDue}`;
            if (role === 'CONTRACTOR') b += '\n\n[협력업체 조치사항] 미비점을 보완하고 개선 결과를 관리시스템에 보고해 주시기 바랍니다.';
          }
          return b;
        },
        sms: (role) => hasFindings && role === 'CONTRACTOR' ? `기술지도 보완요구 - ${v.improveDue}까지 개선결과 보고` : `${v.round}회차 기술지도 결과 등록`,
      }, today());
    },
  },

  submit_improvement: {
    label: '개선결과 보고',
    roles: ['CONTRACTOR'],
    statuses: ['ACTIVE', 'EXTENSION'],
    run(p, { actor, body, files }) {
      const v = findVisit(p, body.visitId);
      if (v.status !== 'IMPROVEMENT_REQUESTED') throw new WfError('보완 요구 상태인 건만 개선결과를 보고할 수 있습니다.');
      if (!body.note) throw new WfError('개선 조치 내용을 입력해 주세요.');
      const recs = saveFiles(p, files, actor, 'IMPROVEMENT', v.id);
      v.improvements = [...(v.improvements || []), { at: today(), note: body.note, files: recs.map((r) => r.id), by: actor.name }];
      v.status = 'IMPROVEMENT_SUBMITTED';
      log(p, actor, 'IMPROVEMENT', `${v.round}회차 미비점 보완 및 개선결과 보고`, body.note);
      notify.send(p, 'IMPROVEMENT_SUBMITTED', ['AGENCY', 'PARTNER_MGMT'], {
        subject: '미비점 보완 및 개선결과 보고',
        body: (role) => `협력업체가 ${v.round}회차 기술지도 미비점에 대한 개선결과를 보고하였습니다.\n개선내용: ${body.note}${role === 'AGENCY' ? '\n\n관리시스템에서 보완사항을 검토해 주시기 바랍니다.' : ''}`,
        sms: (role) => role === 'AGENCY' ? '개선결과 보고됨 - 보완사항 검토 요망' : '협력업체 개선결과 보고',
      }, today());
    },
  },

  review_improvement: {
    label: '개선결과 검토',
    roles: ['AGENCY'],
    statuses: ['ACTIVE', 'EXTENSION'],
    run(p, { actor, body }) {
      const v = findVisit(p, body.visitId);
      if (v.status !== 'IMPROVEMENT_SUBMITTED') throw new WfError('개선결과 검토 대기 건이 아닙니다.');
      const ok = body.decision === 'accept';
      if (!ok && !body.note) throw new WfError('재보완 요청 사유를 입력해 주세요.');
      v.status = ok ? 'CLOSED_OK' : 'IMPROVEMENT_REQUESTED';
      v.reviews = [...(v.reviews || []), { at: today(), ok, note: body.note || '', by: actor.name }];
      log(p, actor, 'IMPROVEMENT_REVIEW', `${v.round}회차 보완사항 검토 — ${ok ? '확인 완료' : '재보완 요청'}`, body.note);
      notify.send(p, 'IMPROVEMENT_REVIEWED', ['CONTRACTOR', 'PARTNER_MGMT', 'SAFETY'], {
        subject: ok ? '보완사항 확인 완료' : '보완사항 재보완 요청',
        body: ok ? `${v.round}회차 기술지도 미비점 보완 결과가 확인 완료되었습니다.` : `${v.round}회차 기술지도 미비점에 대해 재보완이 요청되었습니다.\n사유: ${body.note}\n\n보완 후 개선결과를 다시 보고해 주시기 바랍니다.`,
        sms: ok ? '기술지도 보완사항 확인 완료' : '기술지도 재보완 요청 - 시스템 확인 요망',
      }, today());
    },
  },

  close: {
    label: '종결 조치(현장공사 완료)',
    roles: ['PARTNER_MGMT'],
    statuses: ['ACTIVE'],
    run(p, { actor, body }) {
      const open = (p.visits || []).filter((v) => ['SCHEDULED', 'IMPROVEMENT_REQUESTED', 'IMPROVEMENT_SUBMITTED'].includes(v.status));
      if (open.length && body.force !== 'true') {
        throw new WfError(`미완료 기술지도 건이 ${open.length}건 있습니다(${open.map((v) => `${v.round}회차 ${VISIT_STATUS[v.status]}`).join(', ')}). 처리 후 종결하거나 '미완료 건 포함 종결'을 선택해 주세요.`);
      }
      const cd = body.completionDate || today();
      if (!dates.isValid(cd)) throw new WfError('현장공사 완료일을 확인해 주세요.');
      for (const v of open) if (v.status === 'SCHEDULED') v.status = 'CANCELED';
      p.status = 'CLOSED';
      p.closed = { completionDate: cd, at: today(), by: actor.name, note: body.note || '' };
      const held = (p.visits || []).filter((v) => VISIT_HELD.includes(v.status)).length;
      log(p, actor, 'CLOSED', '현장공사 완료 — 기술지도 종결', `완료일 ${cd}, 기술지도 실시 ${held}회 ${body.note || ''}`);
      notify.send(p, 'CLOSED', ALL4(), {
        subject: '재해예방 기술지도 종결 안내',
        body: (role) => `현장공사 완료(${cd})에 따라 재해예방 기술지도가 종결되었습니다. (기술지도 실시 ${held}회)` +
          (role === 'AGENCY' ? '\n\n기술지도 비용계산서는 별도 정산 시스템 절차에 따라 발급해 주시기 바랍니다.' : ''),
        sms: '재해예방 기술지도 종결',
      }, today());
    },
  },

  start_extension: {
    label: '기술지도 기간 연장 요청',
    roles: ['PARTNER_MGMT', 'PURCHASE'],
    statuses: ['ACTIVE'],
    run(p, { actor, body }) {
      if (!body.note) throw new WfError('연장 사유(공사기간/계약기간 연장 내용)를 입력해 주세요.');
      const round = (p.extensions || []).length + 1;
      p.extension = { round, step: 'PURCHASE', reason: body.note, requestedAt: today(), requestedBy: actor.name, oldEndDate: p.endDate, oldAmount: p.amount };
      p.status = 'EXTENSION';
      log(p, actor, 'EXT_START', `${round}차 기술지도 기간 연장 요청`, body.note);
      notify.send(p, 'EXT_START', ['PURCHASE', ...ALL4()], {
        subject: '기술지도 기간 연장 진행 안내',
        body: (role) => {
          const b = `공사기간(계약기간) 연장에 따라 기술지도 기간 연장 절차가 시작되었습니다.\n사유: ${body.note}\n\n진행순서: ① 구매부서 계약서 갱신 → ② 협력업체 관련서류 제출 → ③ 기술지도기관 추가계약서 제출`;
          return role === 'PURCHASE' ? `${b}\n\n[구매부서 조치사항] 갱신 계약서${p.type === 'UNIT_PRICE' ? '(단가계약: 가계약서/본계약서)' : ''}를 관리시스템에 Upload 해 주시기 바랍니다.` : b;
        },
        sms: (role) => role === 'PURCHASE' ? '기술지도 연장 - 갱신 계약서 시스템 제출 요망' : '기술지도 기간 연장 절차 개시',
      }, today());
    },
  },

  ext_purchase: {
    label: '계약서 갱신 Upload',
    roles: ['PURCHASE'],
    statuses: ['EXTENSION'],
    run(p, { actor, body, files }) {
      if (p.extension.step !== 'PURCHASE') throw new WfError('구매부서 계약서 갱신 단계가 아닙니다.');
      if (!files || !files.length) throw new WfError('갱신 계약서 파일을 첨부해 주세요.');
      if (!dates.isValid(body.newEndDate) || body.newEndDate <= p.endDate) throw new WfError(`연장 종료일은 기존 종료일(${p.endDate}) 이후여야 합니다.`);
      saveFiles(p, files, actor, 'EXT_PURCHASE_CONTRACT', `EXT${p.extension.round}`);
      p.extension.newEndDate = body.newEndDate;
      if (body.newAmount) p.extension.newAmount = Math.round(Number(body.newAmount));
      p.extension.contractKind = body.contractKind || '';
      p.endDate = body.newEndDate;
      if (p.extension.newAmount) p.amount = p.extension.newAmount;
      p.extension.step = 'CONTRACTOR';
      log(p, actor, 'EXT_PURCHASE', `${p.extension.round}차 연장 — 계약서 갱신`, `종료일 ${p.extension.oldEndDate} → ${p.endDate}${p.extension.newAmount ? `, 금액 ${won(p.amount)}` : ''} ${body.contractKind || ''}`);
      notify.send(p, 'EXT_PURCHASE', ['CONTRACTOR', 'PARTNER_MGMT'], {
        subject: '연장 계약서 갱신 완료 — 관련서류 제출 요청',
        body: (role) => `구매부서에서 계약서를 갱신하였습니다(종료일 ${p.endDate}).` + (role === 'CONTRACTOR' ? '\n\n[협력업체 조치사항] 갱신 계약서 또는 납품연기원, 산재가입증명서 갱신 서류 일체를 관리시스템에 제출해 주시기 바랍니다.' : ''),
        sms: (role) => role === 'CONTRACTOR' ? '기술지도 연장 - 갱신서류 시스템 제출 요망' : '연장 계약서 갱신 완료',
      }, today());
    },
  },

  ext_contractor: {
    label: '연장 관련서류 제출',
    roles: ['CONTRACTOR'],
    statuses: ['EXTENSION'],
    run(p, { actor, body, files }) {
      if (p.extension.step !== 'CONTRACTOR') throw new WfError('협력업체 관련서류 제출 단계가 아닙니다.');
      if (!files || files.length < 2) throw new WfError('갱신 계약서(또는 납품연기원)와 산재가입증명서 갱신 서류를 모두 첨부해 주세요.');
      saveFiles(p, files, actor, 'EXT_DOCS', `EXT${p.extension.round}`);
      p.extension.step = 'AGENCY';
      log(p, actor, 'EXT_CONTRACTOR', `${p.extension.round}차 연장 — 협력업체 관련서류 제출`, `${files.map((f) => f.originalName).join(', ')} ${body.note || ''}`);
      notify.send(p, 'EXT_CONTRACTOR', ['AGENCY', 'PARTNER_MGMT'], {
        subject: '연장 관련서류 제출 — 기술지도 추가계약서 제출 요청',
        body: (role) => `협력업체가 연장 관련서류를 제출하였습니다.` + (role === 'AGENCY' ? `\n\n[기술지도기관 조치사항] 기술지도 추가계약서(연장 종료일 ${p.endDate})를 관리시스템에 제출해 주시기 바랍니다.` : ''),
        sms: (role) => role === 'AGENCY' ? '기술지도 연장 - 추가계약서 제출 요망' : '연장 관련서류 제출 완료',
      }, today());
    },
  },

  ext_agency: {
    label: '기술지도 추가계약서 제출',
    roles: ['AGENCY'],
    statuses: ['EXTENSION'],
    run(p, { actor, body, files }) {
      if (p.extension.step !== 'AGENCY') throw new WfError('기술지도기관 추가계약서 제출 단계가 아닙니다.');
      if (!files || !files.length) throw new WfError('기술지도 추가계약서 파일을 첨부해 주세요.');
      const ge = body.guidanceEnd || p.endDate;
      if (!dates.isValid(ge) || ge <= p.guidancePeriod.end) throw new WfError('연장 기술지도 종료일을 확인해 주세요.');
      saveFiles(p, files, actor, 'EXT_TG_CONTRACT', `EXT${p.extension.round}`);
      const old = p.guidancePeriod.end;
      p.guidancePeriod.end = ge;
      p.extensions = [...(p.extensions || []), { ...p.extension, guidanceEndFrom: old, guidanceEndTo: ge, completedAt: today() }];
      p.extension = null;
      p.status = 'ACTIVE';
      log(p, actor, 'EXT_DONE', '기술지도 추가계약서 제출 → 연장 완료', `기술지도 기간 종료 ${old} → ${ge}`);
      notify.send(p, 'EXT_DONE', ALL4(), {
        subject: '재해예방 기술지도 기간 연장 완료',
        body: `기술지도 추가계약이 완료되어 기술지도 기간이 연장되었습니다.\n기술지도 기간: ${p.guidancePeriod.start} ~ ${ge} (기존 종료일 ${old})`,
        sms: `기술지도 기간 연장 완료(~${ge})`,
      }, today());
    },
  },
};

function pick(o, keys) {
  const r = {};
  for (const k of keys) if (o[k] !== undefined) r[k] = o[k];
  return r;
}

function runAction(p, name, ctx) {
  const a = ACTIONS[name];
  if (!a) throw new WfError('알 수 없는 작업입니다.', 404);
  checkActor(ctx.actor, p, a.roles);
  checkStatus(p, a.statuses);
  a.run(p, ctx);
  p.updatedAt = new Date().toISOString();
  if (p.judgment) p.judgment = { ...p.judgment, ...judge(p, store.get().settlements, settings(), today()) };
  return p;
}

// 현재 사용자에게 화면에 보여줄 수 있는 액션 목록
function availableActions(p, user) {
  return Object.entries(ACTIONS)
    .filter(([, a]) => a.statuses.includes(p.status) && (user.role === 'ADMIN' || a.roles.includes(user.role)))
    .filter(([name]) => {
      try { checkActor(user, p, ACTIONS[name].roles); return true; } catch { return false; }
    })
    .map(([name]) => name);
}

// ───────────────────────── 일일 점검(스케줄러) ─────────────────────────

function once(p, key) {
  p.flags = p.flags || {};
  if (p.flags[key]) return false;
  p.flags[key] = today();
  return true;
}

function dailyCheck() {
  const db = store.get();
  const t = today();
  const s = settings();
  const results = [];
  for (const p of db.projects) {
    // 판정 갱신(정산실적/기준 변경 반영)
    if (p.status === 'MONITORING' || p.status === 'NOT_TARGET') {
      const r = applyJudgment(p, SYSTEM);
      if (r.becameTarget) results.push(`${p.name}: 기술지도 대상 전환`);
      if (p.status === 'MONITORING' && p.judgment.warning && once(p, `UNIT_WARNING:${t.slice(0, 4)}`)) {
        notify.send(p, 'UNIT_WARNING', ['PARTNER_MGMT', 'SAFETY'], {
          subject: '단가계약 누적 정산금액 주의',
          body: `단가계약 누적 정산금액이 기술지도 기준금액에 근접하였습니다.\n${p.judgment.reason}\n\n운영방안에 따라 누적금액 1억원 미만 관리(작업 단위 세분화) 또는 기술지도 계약 준비를 검토해 주시기 바랍니다.`,
          sms: '단가계약 누계 기준 근접 - 확인 요망',
        }, t);
        log(p, SYSTEM, 'NOTIFY', '단가계약 누계 주의 안내 발송');
        results.push(`${p.name}: 누계 주의 안내`);
      }
      continue;
    }
    if (!['ACTIVE', 'EXTENSION'].includes(p.status)) continue;
    const c = cycleInfo(p, t);
    // 기간 만료 D-15 안내
    if (c.endIn <= s.endNoticeDays && c.endIn >= 0 && once(p, `END_NOTICE:${p.guidancePeriod.end}`)) {
      notify.send(p, 'END_NOTICE', ALL4(), {
        subject: `기술지도 기간 만료 ${c.endIn}일 전 안내`,
        body: `재해예방 기술지도 기간이 ${p.guidancePeriod.end}에 만료됩니다(D-${c.endIn}).\n\n - 현장공사 완료 시, 기술지도 종결 조치해 주시기 바랍니다.\n - 기술지도 기간 연장 필요 시, 추가 서류(갱신 계약서/납품연기원, 산재가입증명서 갱신, 기술지도 추가계약서)를 제출해 주시기 바랍니다.`,
        sms: `기술지도 기간 만료 D-${c.endIn} - 종결 또는 연장 조치 요망`,
      }, t);
      log(p, SYSTEM, 'NOTIFY', `기간 만료 D-${c.endIn} 자동 안내 발송`);
      results.push(`${p.name}: 만료 D-${c.endIn} 안내`);
    }
    // 기간 경과
    if (c.endIn < 0 && once(p, `EXPIRED:${p.guidancePeriod.end}`)) {
      notify.send(p, 'EXPIRED', ['PARTNER_MGMT', 'SAFETY'], {
        subject: '기술지도 기간 경과 — 조치 필요',
        body: `기술지도 기간(${p.guidancePeriod.end})이 경과하였으나 종결/연장 조치가 되지 않았습니다.\n현장공사 완료 여부를 확인하여 종결 또는 연장 조치해 주시기 바랍니다.`,
        sms: '기술지도 기간 경과 - 종결/연장 조치 요망',
      }, t);
      log(p, SYSTEM, 'NOTIFY', '기술지도 기간 경과 안내 발송');
      results.push(`${p.name}: 기간 경과 안내`);
    }
    // 15일 주기 점검
    if (c.level === 'warn' && !c.upcoming && once(p, `CYCLE_REMIND:${c.anchor}`)) {
      notify.send(p, 'CYCLE_REMIND', ['AGENCY', 'CONTRACTOR', 'PARTNER_MGMT'], {
        subject: '다음 기술지도 일정 지정 요청',
        body: `직전 기술지도(또는 개시일) ${c.anchor} 이후 다음 기술지도 기한은 ${c.nextDue} 입니다.\n아직 일정이 지정되지 않았습니다.\n협력업체는 작업일자를, 기술지도기관은 지도일자를 지정해 주시기 바랍니다.`,
        sms: `다음 기술지도 기한 ${c.nextDue} - 일정 지정 요망`,
      }, t);
      log(p, SYSTEM, 'NOTIFY', `기술지도 주기 안내 (기한 ${c.nextDue})`);
      results.push(`${p.name}: 주기 안내`);
    }
    if (c.level === 'overdue' && once(p, `CYCLE_OVERDUE:${c.anchor}`)) {
      notify.send(p, 'CYCLE_OVERDUE', ['AGENCY', 'CONTRACTOR', 'PARTNER_MGMT', 'SAFETY'], {
        subject: '기술지도 주기 초과(누락 위험)',
        body: `기술지도 기한(${c.nextDue})이 경과하였습니다. 기술지도 누락 위험이 있으니 즉시 기술지도를 실시해 주시기 바랍니다.\n(법정 주기: ${s.cycleDays}일 1회 이상)`,
        sms: `기술지도 기한(${c.nextDue}) 초과 - 즉시 조치`,
      }, t);
      log(p, SYSTEM, 'NOTIFY', `기술지도 주기 초과 경보 (기한 ${c.nextDue})`);
      results.push(`${p.name}: 주기 초과 경보`);
    }
    // 지도일 경과 후 결과 미제출
    for (const v of p.visits || []) {
      if (v.status === 'SCHEDULED' && dates.diffDays(v.plannedDate, t) >= 2 && once(p, `RESULT_REMIND:${v.id}`)) {
        notify.send(p, 'RESULT_REMIND', ['AGENCY', 'PARTNER_MGMT'], {
          subject: '기술지도 결과 제출 요청',
          body: `${v.plannedDate} ${v.round}회차 기술지도 결과가 아직 제출되지 않았습니다. 현장 기술지도 후 결과를 관리시스템에 제출해 주시기 바랍니다.`,
          sms: `${v.plannedDate} 기술지도 결과 제출 요망`,
        }, t);
        results.push(`${p.name}: 결과 제출 요청`);
      }
    }
  }
  db.meta.lastDailyCheck = { date: t, at: new Date().toISOString(), results };
  store.save();
  return { date: t, results };
}

module.exports = {
  STATUS, VISIT_STATUS, ACTIONS, DEFAULT_SETTINGS, WfError,
  settings, today, createProject, applyJudgment, runAction, availableActions,
  canSee, tasks, cycleInfo, dailyCheck, log, SYSTEM,
};
