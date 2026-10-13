'use strict';
// 업무 흐름 통합 테스트: 등록 → 판정/안내 → 자료제출 → 계약 → 일정/결과/보완 → D-15 → 연장 → 종결
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.TG_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-test-'));
const store = require('../server/db');
const wf = require('../server/workflow');
const { seed } = require('../server/seed');
const settlement = require('../server/settlement');
const ExcelJS = require('exceljs');

const db = seed();
db.settings.demoToday = '2026-03-02';
const U = (id) => db.users.find((u) => u.id === id);
const file = (name, category) => ({ buf: Buffer.from('x'), originalName: name, mime: 'text/plain', category });
const run = (p, a, uid, body = {}, files) => wf.runAction(p, a, { actor: U(uid), body, files });
const sent = (p, event) => db.notifications.filter((n) => n.projectId === p.id && n.event === event);

test('대상 공사 전체 흐름', () => {
  const p = wf.createProject({ name: '시험 공사', type: 'GENERAL', companyName: '대한플랜트(주)', startDate: '2026-03-02', endDate: '2026-04-30', amount: 150000000, deptId: 'd_maint', managerUserId: 'u_maint', agencyId: 'ag_1' }, U('u_pur'));
  assert.equal(p.status, 'DOCS_REQUESTED');
  // 대상 안내: 관리부서·협력업체·기관·안전보건 모두, 메일+SMS
  const tn = sent(p, 'TARGET_NOTICE');
  assert.deepEqual(new Set(tn.map((n) => n.toRole)), new Set(['PARTNER_MGMT', 'CONTRACTOR', 'AGENCY', 'SAFETY']));
  assert.ok(tn.some((n) => n.channel === 'SMS') && tn.some((n) => n.channel === 'EMAIL'));
  assert.match(tn.find((n) => n.toRole === 'CONTRACTOR' && n.channel === 'EMAIL').body, /Upload 하여 제출/);

  // 권한: 다른 업체/기관은 수행 불가
  assert.throws(() => run(p, 'upload_docs', 'u_c_donghae', {}, [file('a.pdf', 'CONTRACT')]), /협력업체 사용자만/);
  assert.throws(() => run(p, 'submit_docs', 'u_c_daehan'), /필수 자료가 누락/);
  run(p, 'upload_docs', 'u_c_daehan', {}, [file('계약서.pdf', 'CONTRACT'), file('산재.pdf', 'INSURANCE'), file('사업자.pdf', 'BIZREG')]);
  run(p, 'submit_docs', 'u_c_daehan');
  assert.equal(p.status, 'DOCS_SUBMITTED');

  // 기관 보완요청 → 재제출
  run(p, 'request_supplement', 'u_ag1', { note: '산재보험 가입증명서 최신본 필요' });
  assert.equal(p.status, 'DOCS_REQUESTED');
  run(p, 'submit_docs', 'u_c_daehan');
  assert.throws(() => run(p, 'submit_tg_contract', 'u_ag2', {}, [file('tg.pdf')]), /지정된 기술지도기관만/);
  run(p, 'submit_tg_contract', 'u_ag1', {}, [file('tg.pdf')]);
  assert.equal(p.status, 'ACTIVE');
  assert.equal(p.tgContract.plannedCount, 4); // 60일 / 15일

  // 작업일 지정 → 지도일 선택(작업일 외 불가) → 지정일 안내
  run(p, 'set_work_days', 'u_c_daehan', { month: '2026-03', days: '2026-03-05,2026-03-06,2026-03-16' });
  assert.throws(() => run(p, 'schedule_visit', 'u_ag1', { date: '2026-03-07' }), /작업일자 중에서/);
  run(p, 'schedule_visit', 'u_ag1', { date: '2026-03-05', time: '10:00' });
  assert.equal(sent(p, 'VISIT_SCHEDULED').filter((n) => n.channel === 'EMAIL').length, 4);

  // 결과(보완요구) → 개선보고 → 재보완 → 개선보고 → 확인
  db.settings.demoToday = '2026-03-05';
  assert.throws(() => run(p, 'submit_result', 'u_ag1', { visitId: p.visits[0].id, actualDate: '2026-03-06', summary: 'x' }), /미래 일자/);
  run(p, 'submit_result', 'u_ag1', { visitId: p.visits[0].id, summary: '비계 점검', hasFindings: 'true', findings: '안전난간 미설치' });
  const v = p.visits[0];
  assert.equal(v.status, 'IMPROVEMENT_REQUESTED');
  assert.ok(wf.tasks(p).some((t) => t.role === 'CONTRACTOR' && /개선결과/.test(t.label)));
  run(p, 'submit_improvement', 'u_c_daehan', { visitId: v.id, note: '난간 설치' });
  run(p, 'review_improvement', 'u_ag1', { visitId: v.id, decision: 'reject', note: '중간난간 누락' });
  assert.equal(v.status, 'IMPROVEMENT_REQUESTED');
  run(p, 'submit_improvement', 'u_c_daehan', { visitId: v.id, note: '중간난간 설치' });
  run(p, 'review_improvement', 'u_ag1', { visitId: v.id, decision: 'accept' });
  assert.equal(v.status, 'CLOSED_OK');

  // 15일 주기: 3/5 지도 → 기한 3/20. 3/21 점검 시 초과 경보
  assert.equal(wf.cycleInfo(p).nextDue, '2026-03-20');
  db.settings.demoToday = '2026-03-21';
  wf.dailyCheck();
  assert.equal(sent(p, 'CYCLE_OVERDUE').length > 0, true);
  const before = sent(p, 'CYCLE_OVERDUE').length;
  wf.dailyCheck();
  assert.equal(sent(p, 'CYCLE_OVERDUE').length, before, '같은 경보는 1회만 발송');

  // 만료 D-15 안내 (4/30 종료 → 4/15)
  db.settings.demoToday = '2026-04-15';
  wf.dailyCheck();
  const end = sent(p, 'END_NOTICE').filter((n) => n.channel === 'EMAIL');
  assert.equal(end.length, 4);
  assert.match(end[0].body, /종결 조치/);
  assert.match(end[0].body, /연장 필요 시/);

  // 연장: 구매 → 협력업체 → 기관 (순서 강제)
  run(p, 'start_extension', 'u_maint', { note: '설계변경으로 공기 연장' });
  assert.equal(p.status, 'EXTENSION');
  assert.throws(() => run(p, 'ext_agency', 'u_ag1', {}, [file('add.pdf')]), /추가계약서 제출 단계가 아닙니다/);
  run(p, 'ext_purchase', 'u_pur', { newEndDate: '2026-05-31' }, [file('갱신계약서.pdf')]);
  assert.throws(() => run(p, 'ext_contractor', 'u_c_daehan', {}, [file('a.pdf')]), /모두 첨부/);
  run(p, 'ext_contractor', 'u_c_daehan', {}, [file('납품연기원.pdf', 'EXT_DOCS'), file('산재갱신.pdf', 'EXT_INSURANCE')]);
  run(p, 'ext_agency', 'u_ag1', { guidanceEnd: '2026-05-31' }, [file('추가계약서.pdf')]);
  assert.equal(p.status, 'ACTIVE');
  assert.equal(p.guidancePeriod.end, '2026-05-31');

  // 연장 후 새 종료일 기준 D-15 재안내
  db.settings.demoToday = '2026-05-16';
  wf.dailyCheck();
  assert.ok(db.notifications.some((n) => n.projectId === p.id && n.event === 'END_NOTICE' && n.date === '2026-05-16'));

  // 종결
  run(p, 'close', 'u_maint', { completionDate: '2026-05-20' });
  assert.equal(p.status, 'CLOSED');
  assert.equal(sent(p, 'CLOSED').filter((n) => n.channel === 'EMAIL').length, 4);
});

test('비대상 공사는 정보 수정 시 재판정되어 대상 전환', () => {
  db.settings.demoToday = '2026-03-02';
  const p = wf.createProject({ name: '소규모 공사', type: 'GENERAL', companyName: '동해기전(주)', startDate: '2026-03-02', endDate: '2026-04-30', amount: 50000000 }, U('u_pur'));
  assert.equal(p.status, 'NOT_TARGET');
  run(p, 'update_info', 'u_pur', { amount: '120000000' });
  assert.equal(p.status, 'DOCS_REQUESTED');
  assert.equal(p.agencyId, 'ag_1', '기본 기관 자동 지정');
});

test('정산실적 Upload로 누계 1억 도달 시 자동 대상 전환', async () => {
  db.settings.demoToday = '2026-06-10';
  const p = wf.createProject({ contractNo: 'U-T-1', name: '[단가계약] 시험 단가공사', type: 'UNIT_PRICE', companyName: '한빛계전(주)', startDate: '2026-01-01', endDate: '2026-12-31', amount: 70000000 }, U('u_pur'));
  assert.equal(p.status, 'MONITORING');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('s');
  ws.addRow(['계약번호', '공사계약명', '업체명', '정산월', '정산금액']);
  ws.addRow(['U-T-1', '', '', '2026-01', 30000000]);
  ws.addRow(['U-T-1', '', '', '2026-02', 30000000]);
  ws.addRow(['', '[단가계약] 시험 단가공사', '', '2026-03', 45000000]); // 계약명으로 매칭
  ws.addRow(['NO-MATCH', '', '', '2026-03', 1]);
  const buf = await wb.xlsx.writeBuffer();
  const r = await settlement.importSettlements(Buffer.from(buf), 's.xlsx', U('u_pur'));
  assert.equal(r.inserted, 3);
  assert.equal(r.unmatched.length, 1);
  wf.applyJudgment(p, U('u_pur'));
  assert.equal(p.status, 'DOCS_REQUESTED');
  assert.equal(p.judgment.triggerMonth, '2026-03');
  assert.equal(p.guidancePeriod.start, '2026-06-10', '누계 도달 시점부터 기술지도 대상기간');
  // 재업로드 시 같은 월은 갱신
  const r2 = await settlement.importSettlements(Buffer.from(buf), 's.xlsx', U('u_pur'));
  assert.equal(r2.inserted, 0);
});

test('가로형(1월~12월) 정산 양식', async () => {
  const p = db.projects.find((x) => x.contractNo === 'U-2026-0104');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('s');
  ws.addRow(['계약번호', '연도', '1월', '2월']);
  ws.addRow(['U-2026-0104', 2025, 1000, 2000]);
  const r = await settlement.importSettlements(Buffer.from(await wb.xlsx.writeBuffer()), 'w.xlsx', U('u_pur'));
  assert.equal(r.inserted, 2);
  assert.ok(db.settlements.some((s) => s.projectId === p.id && s.month === '2025-02' && s.amount === 2000));
});

test('가시성: 협력업체는 자사 공사만, 기관은 지정 공사만', () => {
  const c = U('u_c_hanbit');
  assert.ok(db.projects.filter((p) => wf.canSee(c, p)).every((p) => p.companyId === 'co_hanbit'));
  const a = U('u_ag2');
  assert.ok(db.projects.filter((p) => wf.canSee(a, p)).every((p) => p.agencyId === 'ag_2'));
});

test.after(() => fs.rmSync(store.DATA_DIR, { recursive: true, force: true }));
