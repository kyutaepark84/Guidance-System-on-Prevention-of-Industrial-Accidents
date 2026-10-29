'use strict';
// 업무 흐름 통합 테스트(Ver.2): 등록 → 판정/안내(담당자) → 서류제출 → 계약서(개시) → 일정/결과/회차 → 주기초과 사유 → 만료안내 → 연장 → 종결
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
const userimport = require('../server/userimport');
const ExcelJS = require('exceljs');

const db = seed();
db.settings.demoToday = '2026-03-02';
const U = (id) => db.users.find((u) => u.id === id);
const file = (name, category) => ({ buf: Buffer.from('x'), originalName: name, mime: 'text/plain', category });
const run = (p, a, uid, body = {}, files) => wf.runAction(p, a, { actor: U(uid), body, files });
const sent = (p, event, channel = 'EMAIL') => db.notifications.filter((n) => n.projectId === p.id && n.event === event && n.channel === channel);

test('대상 공사 전체 흐름', () => {
  const p = wf.createProject({
    contractNo: 'T-1', name: '시험 공사', type: 'GENERAL', companyName: '대한플랜트(주)', startDate: '2026-03-02', endDate: '2026-04-30', amount: 150000000,
    deptId: 'd_maint', managerUserId: 'u_maint', agencyId: 'ag_1', contact_SAFETY: 'u_safe', contact_AGENCY: 'u_ag1',
    new_CONTRACTOR_name: '신규담당', new_CONTRACTOR_phone: '010-1111-2222', new_CONTRACTOR_email: 'new@example.com',
  }, U('u_pur'));
  assert.equal(p.status, 'DOCS_REQUESTED');
  // 대상 안내: 지정된 담당자에게만(안전보건 2명 중 최안전만), 신규 등록한 협력업체 담당자 포함
  const tn = sent(p, 'TARGET_NOTICE');
  assert.deepEqual(tn.map((n) => n.toName).sort(), ['강지도', '박정비', '신규담당', '최안전'].sort());
  assert.ok(sent(p, 'TARGET_NOTICE', 'SMS').some((n) => n.toAddr === '010-1111-2222'));
  assert.equal(p.contacts.PURCHASE, 'u_pur', '등록한 구매 담당자가 구매 담당자로 지정');

  // 담당자 변경 시 새 담당자에게 대상 안내 재발송
  run(p, 'assign', 'u_maint', { contact_SAFETY: 'u_safe2' });
  assert.ok(sent(p, 'TARGET_NOTICE').some((n) => n.toName === '양안전'));

  // 서류 제출: 파일 첨부와 제출을 한 번에, 산재보험 가입증명서만 필수
  assert.throws(() => run(p, 'submit_docs', 'u_c_donghae', {}, [file('a.pdf', 'INSURANCE')]), /협력업체 사용자만/);
  assert.throws(() => run(p, 'submit_docs', 'u_c_daehan', {}, []), /산재보험 가입증명서/);
  run(p, 'submit_docs', 'u_c_daehan', {}, [file('산재.pdf', 'INSURANCE')]);
  assert.equal(p.status, 'DOCS_SUBMITTED');

  // 기술지도 계약서 제출 → 개시
  assert.throws(() => run(p, 'submit_tg_contract', 'u_ag2', {}, [file('tg.pdf')]), /지정된 기술지도기관만/);
  run(p, 'submit_tg_contract', 'u_ag1', { contractDate: '2026-03-01', guidanceStart: '2026-03-02', guidanceEnd: '2026-04-30', plannedCount: '4', moelSubmitted: 'true' }, [file('tg.pdf')]);
  assert.equal(p.status, 'ACTIVE');
  assert.equal(p.tgContract.plannedCount, 4);
  assert.equal(p.tgContract.moelSubmitted, true);
  assert.ok(!wf.ACTIONS.safety_check && !wf.ACTIONS.request_supplement && !wf.ACTIONS.submit_improvement, '삭제된 기능');

  // 작업일 → 지도일. 앞선 회차보다 빠른 일정을 잡으면 회차 재정렬
  run(p, 'set_work_days', 'u_c_daehan', { month: '2026-03', days: '2026-03-05,2026-03-10,2026-03-16' });
  run(p, 'schedule_visit', 'u_ag1', { date: '2026-03-10', time: '10:00' });
  run(p, 'schedule_visit', 'u_ag1', { date: '2026-03-05', time: '10:00' });
  const byDate = Object.fromEntries(p.visits.map((v) => [v.plannedDate, v.round]));
  assert.deepEqual(byDate, { '2026-03-05': 1, '2026-03-10': 2 });

  // 결과: 실제 지도일 + 결과보고서만
  db.settings.demoToday = '2026-03-05';
  const v1 = p.visits.find((v) => v.plannedDate === '2026-03-05');
  assert.throws(() => run(p, 'submit_result', 'u_ag1', { visitId: v1.id }, []), /결과보고서 파일/);
  run(p, 'submit_result', 'u_ag1', { visitId: v1.id, actualDate: '2026-03-05' }, [file('결과보고서.pdf')]);
  assert.equal(v1.status, 'DONE');
  run(p, 'cancel_visit', 'u_ag1', { visitId: p.visits.find((v) => v.plannedDate === '2026-03-10').id, note: '우천' });

  // 15일 주기: 3/5 지도 → 기한 3/20. 3/25 초과 → 경보 + 협력업체 미실시 사유 작성
  db.settings.demoToday = '2026-03-25';
  wf.dailyCheck();
  assert.ok(sent(p, 'CYCLE_OVERDUE').length > 0);
  const gap = wf.cycleGaps(p).find((g) => !g.reason);
  assert.equal(gap.due, '2026-03-20');
  assert.ok(wf.tasks(p).some((t) => t.role === 'CONTRACTOR' && /미실시/.test(t.label)));
  assert.throws(() => run(p, 'gap_reason', 'u_c_daehan', { due: gap.due, code: 'ETC' }), /기타 사유/);
  run(p, 'gap_reason', 'u_c_daehan', { due: gap.due, code: 'NO_WORK' });
  assert.equal(wf.cycleGaps(p)[0].reason.label, '기술지도 후 15일 이내 작업 없음');

  // 만료 안내: 일반공사 D-10 (4/30 → 4/20), 구매 담당자 포함
  db.settings.demoToday = '2026-04-19';
  wf.dailyCheck();
  assert.equal(sent(p, 'END_NOTICE').length, 0);
  db.settings.demoToday = '2026-04-20';
  wf.dailyCheck();
  const end = sent(p, 'END_NOTICE');
  assert.ok(end.some((n) => n.toRole === 'PURCHASE'));
  assert.match(end[0].body, /종결 조치/);

  // 연장: 구매 → 협력업체(연장계약 종료일) → 기관(기본값 = 협력업체 종료일)
  run(p, 'start_extension', 'u_maint', { note: '설계변경으로 공기 연장' });
  run(p, 'ext_purchase', 'u_pur', { newEndDate: '2026-05-31', newAmount: '180,000,000' }, [file('갱신계약서.pdf')]);
  assert.equal(p.amount, 180000000);
  assert.throws(() => run(p, 'ext_contractor', 'u_c_daehan', {}, [file('납품연기원.pdf', 'EXT_DOCS')]), /산재가입증명서/);
  run(p, 'ext_contractor', 'u_c_daehan', { newEndDate: '2026-05-25' }, [file('산재갱신.pdf', 'EXT_INSURANCE')]);
  run(p, 'ext_agency', 'u_ag1', {}, [file('추가계약서.pdf')]);
  assert.equal(p.status, 'ACTIVE');
  assert.equal(p.guidancePeriod.end, '2026-05-25');

  // 종결
  run(p, 'close', 'u_maint', { completionDate: '2026-05-20' });
  assert.equal(p.status, 'CLOSED');
});

test('단가계약 만료 안내는 30일 전', () => {
  db.settings.demoToday = '2026-03-02';
  const p = wf.createProject({ name: '[단가계약] 시험', type: 'UNIT_PRICE', companyName: '한빛계전(주)', startDate: '2026-03-01', endDate: '2026-06-30', amount: 150000000, deptId: 'd_elec', agencyId: 'ag_1' }, U('u_pur'));
  run(p, 'submit_docs', 'u_c_hanbit', {}, [file('산재.pdf', 'INSURANCE')]);
  run(p, 'submit_tg_contract', 'u_ag1', {}, [file('tg.pdf')]);
  db.settings.demoToday = '2026-05-30';
  wf.dailyCheck();
  assert.equal(sent(p, 'END_NOTICE').length, 0, 'D-31에는 안내 없음');
  db.settings.demoToday = '2026-05-31';
  wf.dailyCheck();
  assert.ok(sent(p, 'END_NOTICE').length > 0, 'D-30에 안내');
});

test('협력업체 관리부서는 필수, 정보 수정 시 재판정', () => {
  db.settings.demoToday = '2026-03-02';
  assert.throws(() => wf.createProject({ name: 'x', type: 'GENERAL', companyName: 'A(주)', startDate: '2026-03-02', endDate: '2026-04-30', amount: 1 }, U('u_pur')), /관리부서/);
  const p = wf.createProject({ name: '소규모 공사', type: 'GENERAL', companyName: '동해기전(주)', startDate: '2026-03-02', endDate: '2026-04-30', amount: 50000000, deptId: 'd_prod_pe' }, U('u_pur'));
  assert.equal(p.status, 'NOT_TARGET');
  run(p, 'update_info', 'u_pur', { amount: '120000000' });
  assert.equal(p.status, 'DOCS_REQUESTED');
});

test('정산실적 Upload로 누계 1억 도달 시 자동 대상 전환', async () => {
  db.settings.demoToday = '2026-06-10';
  const p = wf.createProject({ contractNo: 'U-T-1', name: '[단가계약] 시험 단가공사', type: 'UNIT_PRICE', companyName: '한빛계전(주)', startDate: '2026-01-01', endDate: '2026-12-31', amount: 70000000, deptId: 'd_elec' }, U('u_pur'));
  assert.equal(p.status, 'MONITORING');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('s');
  ws.addRow(['계약번호', '공사계약명', '업체명', '정산월', '정산금액']);
  ws.addRow(['U-T-1', '', '', '2026-01', 30000000]);
  ws.addRow(['U-T-1', '', '', '2026-02', 30000000]);
  ws.addRow(['', '[단가계약] 시험 단가공사', '', '2026-03', 45000000]);
  ws.addRow(['NO-MATCH', '', '', '2026-03', 1]);
  const buf = await wb.xlsx.writeBuffer();
  const r = await settlement.importSettlements(Buffer.from(buf), 's.xlsx', U('u_pur'));
  assert.equal(r.inserted, 3);
  assert.equal(r.unmatched.length, 1);
  wf.applyJudgment(p, U('u_pur'));
  assert.equal(p.status, 'DOCS_REQUESTED');
  assert.equal(p.guidancePeriod.start, '2026-06-10');
});

test('담당자 일괄 Upload', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('담당자');
  ws.addRow(['역할', '소속', '이름', '직책', '이메일', '휴대폰']);
  ws.addRow(['협력업체 관리부서', '생산팀(PVC2)', '홍생산', '공사담당', 'pvc2@example.com', '010-2222-3333']);
  ws.addRow(['협력업체', '새한공영(주)', '김소장', '현장소장', '', '010-4444-5555']);
  ws.addRow(['기술지도기관', '산업안전관리', '이지도', '지도요원', '', '']);
  ws.addRow(['안전보건환경부서', '정비팀', '오류', '', '', '']);
  ws.addRow(['없는역할', 'x', 'y', '', '', '']);
  const r = await userimport.importUsers(Buffer.from(await wb.xlsx.writeBuffer()), 'u.xlsx');
  assert.equal(r.inserted, 3);
  assert.equal(r.errors.length, 2);
  assert.ok(db.companies.some((c) => c.name === '새한공영(주)'));
  assert.ok(db.users.some((u) => u.name === '홍생산' && u.orgId === 'd_prod_pvc2'));
  const r2 = await userimport.importUsers(Buffer.from(await wb.xlsx.writeBuffer()), 'u.xlsx');
  assert.equal(r2.inserted, 0);
});

test('Ver.1 데이터 마이그레이션', () => {
  const old = {
    meta: { version: 1 }, settings: { endNoticeDays: 15, docTypes: [] },
    departments: [{ id: 'd_prod', name: '생산팀', kind: 'PARTNER_MGMT' }], agencies: [{ id: 'ag_1', name: 'A' }], companies: [], users: [{ id: 'u_pur', role: 'PURCHASE' }],
    projects: [{ id: 'p', createdBy: 'u_pur', managerUserId: 'u_m', deptId: 'd_maint', workPlace: 'x', visits: [{ id: 'a', status: 'IMPROVEMENT_REQUESTED', actualDate: '2026-01-10', plannedDate: '2026-01-10', round: 2 }, { id: 'b', status: 'DONE', actualDate: '2026-01-01', plannedDate: '2026-01-01', round: 1 }] }],
  };
  assert.equal(wf.migrate(old), true);
  assert.ok(old.departments.some((d) => d.name === '생산팀(PVC1)'));
  assert.ok(!old.departments.some((d) => d.id === 'd_prod'), '사용되지 않는 생산팀 제거');
  assert.ok(old.agencies.some((a) => a.name === '산업안전관리'));
  assert.equal(old.projects[0].contacts.PARTNER_MGMT, 'u_m');
  assert.equal(old.projects[0].contacts.PURCHASE, 'u_pur');
  assert.equal(old.projects[0].visits.find((v) => v.id === 'a').status, 'DONE');
  assert.equal(old.settings.endNoticeDays, undefined);
  assert.equal(wf.migrate(old), false);
});

test('가시성: 협력업체는 자사 공사만, 기관은 지정 공사만', () => {
  const c = U('u_c_hanbit');
  assert.ok(db.projects.filter((p) => wf.canSee(c, p)).every((p) => p.companyId === 'co_hanbit'));
  const a = U('u_ag2');
  assert.ok(db.projects.filter((p) => wf.canSee(a, p)).every((p) => p.agencyId === 'ag_2'));
});

test.after(() => fs.rmSync(store.DATA_DIR, { recursive: true, force: true }));
