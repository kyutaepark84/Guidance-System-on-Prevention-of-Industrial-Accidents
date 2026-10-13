'use strict';
// DEMO 기준정보 및 시연용 공사 데이터. 모든 날짜는 '오늘' 기준 상대값으로 생성한다.
// (가상의 업체·기관·인물이며, 실제와 무관)
const store = require('./db');
const dates = require('./dates');
const wf = require('./workflow');

function masters(db) {
  db.departments = [
    { id: 'd_pur', name: '구매팀', kind: 'PURCHASE' },
    { id: 'd_maint', name: '정비팀', kind: 'PARTNER_MGMT' },
    { id: 'd_elec', name: '계전팀', kind: 'PARTNER_MGMT' },
    { id: 'd_fac', name: '설비팀', kind: 'PARTNER_MGMT' },
    { id: 'd_prod', name: '생산팀', kind: 'PARTNER_MGMT' },
    { id: 'd_safe', name: '안전보건환경팀', kind: 'SAFETY' },
  ];
  db.companies = [
    { id: 'co_daehan', name: '대한플랜트(주)', bizNo: '000-00-00001', phone: '052-000-0001', email: 'office@daehan.example.com' },
    { id: 'co_donghae', name: '동해기전(주)', bizNo: '000-00-00002', phone: '052-000-0002', email: 'office@donghae.example.com' },
    { id: 'co_ulsan', name: '울산산업개발(주)', bizNo: '000-00-00003', phone: '052-000-0003', email: 'office@usd.example.com' },
    { id: 'co_taehwa', name: '태화이엔지(주)', bizNo: '000-00-00004', phone: '052-000-0004', email: 'office@taehwa.example.com' },
    { id: 'co_hanbit', name: '한빛계전(주)', bizNo: '000-00-00005', phone: '052-000-0005', email: 'office@hanbit.example.com' },
  ];
  db.agencies = [
    { id: 'ag_1', name: '한국재해예방기술원 울산센터', phone: '052-100-0001', email: 'ulsan@tg-agency1.example.com' },
    { id: 'ag_2', name: '동남건설안전기술지도원', phone: '052-100-0002', email: 'info@tg-agency2.example.com' },
  ];
  const u = (id, name, role, orgId, title, n) => ({ id, name, role, orgId, title, email: `${id.replace('u_', '')}@example.com`, phone: `010-0000-${String(n).padStart(4, '0')}`, active: true });
  db.users = [
    u('u_admin', '시스템관리자', 'ADMIN', null, '관리자', 1),
    u('u_pur', '김구매', 'PURCHASE', 'd_pur', '구매팀 계약담당', 11),
    u('u_maint', '박정비', 'PARTNER_MGMT', 'd_maint', '정비팀 공사담당', 21),
    u('u_elec', '이계전', 'PARTNER_MGMT', 'd_elec', '계전팀 공사담당', 22),
    u('u_fac', '정설비', 'PARTNER_MGMT', 'd_fac', '설비팀 공사담당', 23),
    u('u_safe', '최안전', 'SAFETY', 'd_safe', '안전보건환경팀 담당', 31),
    u('u_ag1', '강지도', 'AGENCY', 'ag_1', '기술지도요원', 41),
    u('u_ag2', '윤지도', 'AGENCY', 'ag_2', '기술지도요원', 42),
    u('u_c_daehan', '한소장', 'CONTRACTOR', 'co_daehan', '현장소장', 51),
    u('u_c_donghae', '오소장', 'CONTRACTOR', 'co_donghae', '현장소장', 52),
    u('u_c_ulsan', '서소장', 'CONTRACTOR', 'co_ulsan', '현장소장', 53),
    u('u_c_taehwa', '문소장', 'CONTRACTOR', 'co_taehwa', '현장소장', 54),
    u('u_c_hanbit', '배소장', 'CONTRACTOR', 'co_hanbit', '현장소장', 55),
  ];
  db.settings = { ...wf.DEFAULT_SETTINGS, defaultAgencyId: 'ag_1' };
}

function fakeFile(name, text) {
  return { buf: Buffer.from(text || `DEMO 샘플 파일: ${name}\n`, 'utf8'), originalName: name, mime: 'text/plain' };
}

function seed() {
  const db = store.reset();
  masters(db);
  const T = wf.today();
  const d = (n) => dates.addDays(T, n);
  const user = (id) => db.users.find((x) => x.id === id);
  const PUR = user('u_pur');
  const act = (p, name, actorId, body = {}, files) => wf.runAction(p, name, { actor: user(actorId), body, files });
  const docs = (p, cid) => {
    act(p, 'upload_docs', cid, {}, [
      { ...fakeFile('공사계약서.pdf'), category: 'CONTRACT' },
      { ...fakeFile('산재보험가입증명서.pdf'), category: 'INSURANCE' },
      { ...fakeFile('사업자등록증.pdf'), category: 'BIZREG' },
    ]);
    act(p, 'submit_docs', cid);
  };
  const setDays = (p, cid, list) => {
    const byMonth = {};
    list.forEach((x) => { (byMonth[x.slice(0, 7)] = byMonth[x.slice(0, 7)] || []).push(x); });
    Object.entries(byMonth).forEach(([m, ds]) => act(p, 'set_work_days', cid, { month: m, days: ds.join(',') }));
  };
  const start = (p, cid, agId) => {
    docs(p, cid);
    act(p, 'submit_tg_contract', agId, { contractDate: p.guidancePeriod.start }, [fakeFile('재해예방기술지도_계약서.pdf')]);
  };
  const year = T.slice(0, 4);
  const curMonth = +T.slice(5, 7);

  // ① 일반공사 – 기술지도 진행중(1회차 완료, 2회차 예정)
  const p1 = wf.createProject({ contractNo: 'C-2026-0412', name: 'No.2 NCC 열교환기(E-2105) 교체공사', type: 'GENERAL', companyName: '대한플랜트(주)', startDate: d(-20), endDate: d(70), amount: 380000000, deptId: 'd_maint', managerUserId: 'u_maint', workPlace: 'No.2 NCC' }, PUR);
  start(p1, 'u_c_daehan', 'u_ag1');
  act(p1, 'safety_check', 'u_safe', { note: '계약서 및 노동부 제출 확인' });
  setDays(p1, 'u_c_daehan', [d(-14), d(-13), d(-12), d(2), d(3), d(4)]);
  act(p1, 'schedule_visit', 'u_ag1', { date: d(-12), time: '10:00', inspector: '강지도' });
  act(p1, 'submit_result', 'u_ag1', { visitId: p1.visits[0].id, actualDate: d(-12), summary: '고소작업(비계) 안전난간, 화기작업 감시인 배치 상태 점검 — 양호', hasFindings: 'false', moelReported: 'true' }, [fakeFile('1회차_기술지도결과보고서.pdf')]);
  if (p1.workDays.includes(d(3))) act(p1, 'schedule_visit', 'u_ag1', { date: d(3), time: '14:00', inspector: '강지도' });

  // ② 일반공사 – 금액 미달 → 대상 아님
  wf.createProject({ contractNo: 'C-2026-0388', name: 'PP공장 배관 보온 보수공사', type: 'GENERAL', companyName: '동해기전(주)', startDate: d(-5), endDate: d(55), amount: 80000000, deptId: 'd_maint', managerUserId: 'u_maint' }, PUR);

  // ③ 일반공사 – 공사기간 1개월 미만 → 대상 아님
  wf.createProject({ contractNo: 'C-2026-0391', name: '냉각탑 Fan Deck 보강공사', type: 'GENERAL', companyName: '울산산업개발(주)', startDate: d(2), endDate: d(21), amount: 150000000, deptId: 'd_fac', managerUserId: 'u_fac' }, PUR);

  // ④ 단가계약 – 계약금액 1억 이상 → 대상, 협력업체 자료제출 대기
  wf.createProject({ contractNo: 'U-2026-0101', name: `[단가계약] ${year}년 1공장 기계정비 단가공사`, type: 'UNIT_PRICE', companyName: '대한플랜트(주)', startDate: d(-1), endDate: `${year}-12-31`, amount: 240000000, deptId: 'd_maint', managerUserId: 'u_maint', workPlace: '1공장' }, PUR);

  // ⑤ 단가계약 – 1억 미만, 누계 80% 이상 → 주의(누계관리)
  const p5 = wf.createProject({ contractNo: 'U-2026-0102', name: `[단가계약] ${year}년 2공장 계장정비 단가공사`, type: 'UNIT_PRICE', companyName: '한빛계전(주)', startDate: `${year}-01-01`, endDate: `${year}-12-31`, amount: 90000000, deptId: 'd_elec', managerUserId: 'u_elec', workPlace: '2공장' }, PUR);
  // ⑥ 단가계약 – 1억 미만이나 누계 1억 초과 → 대상(누계), 기관 검토 대기
  const p6 = wf.createProject({ contractNo: 'U-2026-0103', name: `[단가계약] ${year}년 설비 보온·도장 단가공사`, type: 'UNIT_PRICE', companyName: '태화이엔지(주)', startDate: `${year}-01-01`, endDate: `${year}-12-31`, amount: 60000000, deptId: 'd_fac', managerUserId: 'u_fac', workPlace: '전 공장' }, PUR);
  // ⑨ 단가계약 – 소액, 누계 여유
  const p9 = wf.createProject({ contractNo: 'U-2026-0104', name: `[단가계약] ${year}년 생산팀 소모품 교체 단가공사`, type: 'UNIT_PRICE', companyName: '동해기전(주)', startDate: `${year}-01-01`, endDate: `${year}-12-31`, amount: 30000000, deptId: 'd_maint', managerUserId: 'u_maint' }, PUR);

  const months = Array.from({ length: Math.max(1, curMonth - 1) }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
  const spread = (p, total) => months.forEach((m, i) => db.settlements.push({ id: store.id('s'), projectId: p.id, month: m, amount: Math.round((total / months.length) * (0.85 + ((i * 37) % 30) / 100)), source: 'DEMO', uploadedBy: 'u_pur', uploadedAt: new Date().toISOString() }));
  spread(p5, 83000000);
  spread(p6, 104000000);
  spread(p9, 12000000);
  wf.applyJudgment(p5, wf.SYSTEM);
  wf.applyJudgment(p6, wf.SYSTEM);
  wf.applyJudgment(p9, wf.SYSTEM);
  if (p6.status === 'DOCS_REQUESTED') { p6.agencyId = 'ag_2'; docs(p6, 'u_c_taehwa'); }

  // ⑦ 일반공사 – 진행중, 만료 D-10, 보완요구 진행
  const p7 = wf.createProject({ contractNo: 'C-2026-0217', name: 'BD공장 Flare Stack 정비공사', type: 'GENERAL', companyName: '울산산업개발(주)', startDate: d(-80), endDate: d(10), amount: 220000000, deptId: 'd_prod', managerUserId: 'u_maint', agencyId: 'ag_2', workPlace: 'BD공장' }, PUR);
  start(p7, 'u_c_ulsan', 'u_ag2');
  setDays(p7, 'u_c_ulsan', [d(-75), d(-60), d(-45), d(-31), d(-16), d(-6), d(5), d(6)]);
  [d(-75), d(-60), d(-45), d(-31), d(-16)].forEach((x, i) => {
    act(p7, 'schedule_visit', 'u_ag2', { date: x, time: '09:30', inspector: '윤지도' });
    const v = p7.visits[p7.visits.length - 1];
    act(p7, 'submit_result', 'u_ag2', { visitId: v.id, actualDate: x, summary: `${i + 1}회차 현장 순회 지도 (Flare Tip 교체 양중작업, 밀폐공간 작업)`, hasFindings: i === 4 ? 'true' : 'false', findings: '크레인 아웃트리거 받침목 미설치, 밀폐공간 산소농도 측정기록 누락', improveDue: d(-9), moelReported: 'true' }, [fakeFile(`${i + 1}회차_기술지도결과보고서.pdf`)]);
  });
  act(p7, 'safety_check', 'u_safe', { note: '확인' });

  // ⑧ 종결된 공사
  const p8 = wf.createProject({ contractNo: 'C-2026-0105', name: 'Tank Farm 방유제 보수공사', type: 'GENERAL', companyName: '동해기전(주)', startDate: d(-120), endDate: d(-30), amount: 130000000, deptId: 'd_maint', managerUserId: 'u_maint' }, PUR);
  start(p8, 'u_c_donghae', 'u_ag1');
  act(p8, 'safety_check', 'u_safe', {});
  setDays(p8, 'u_c_donghae', [d(-100)]);
  act(p8, 'schedule_visit', 'u_ag1', { date: d(-100), time: '10:00' });
  act(p8, 'submit_result', 'u_ag1', { visitId: p8.visits[0].id, summary: '방유제 굴착 및 거푸집 작업 지도 — 양호', hasFindings: 'false' }, [fakeFile('기술지도결과.pdf')]);
  act(p8, 'close', 'u_maint', { completionDate: d(-30), note: '현장공사 완료', force: 'true' });

  // 시드 과정의 발송 기록은 '시연 이전 이력'으로 읽음 처리
  for (const n of db.notifications) n.read = true;
  wf.dailyCheck();
  store.save();
  return db;
}

module.exports = { seed };
