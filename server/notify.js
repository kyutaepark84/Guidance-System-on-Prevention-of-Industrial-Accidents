'use strict';
// 자동 안내(E-메일/SMS). DEMO에서는 실제로 발송하지 않고 '발송함'(notifications)에 기록하며,
// 각 사용자의 알림함에서 확인할 수 있다. 사내 메일/SMS 게이트웨이 연동 시 deliver()만 교체한다.
const store = require('./db');
const { won } = require('./rules');

const ROLE_LABEL = {
  PURCHASE: '구매부서',
  PARTNER_MGMT: '협력업체 관리부서',
  SAFETY: '안전보건환경부서',
  AGENCY: '기술지도기관',
  CONTRACTOR: '협력업체',
  ADMIN: '시스템 관리자',
};

// 프로젝트 기준으로 역할별 수신자(사용자)를 찾는다.
function recipients(project, roles) {
  const db = store.get();
  const out = [];
  const add = (u) => { if (u && u.active !== false && !out.some((x) => x.id === u.id)) out.push(u); };
  for (const role of roles) {
    const users = db.users.filter((u) => u.role === role);
    if (role === 'PARTNER_MGMT') {
      const mgr = users.find((u) => u.id === project.managerUserId);
      add(mgr);
      users.filter((u) => u.orgId === project.deptId).forEach(add);
    } else if (role === 'CONTRACTOR') {
      users.filter((u) => u.orgId === project.companyId).forEach(add);
    } else if (role === 'AGENCY') {
      users.filter((u) => project.agencyId && u.orgId === project.agencyId).forEach(add);
    } else {
      users.forEach(add); // 안전보건환경부서, 구매부서: 부서 전체
    }
  }
  return out;
}

function projectSummary(p) {
  const period = p.guidancePeriod ? `${p.guidancePeriod.start} ~ ${p.guidancePeriod.end}` : '-';
  return [
    `■ 공사계약명 : ${p.name}${p.type === 'UNIT_PRICE' ? ' [단가계약]' : ''}`,
    `■ 업체명     : ${p.companyName}`,
    `■ 계약기간   : ${p.startDate} ~ ${p.endDate}`,
    `■ 계약금액   : ${won(p.amount)}`,
    `■ 기술지도 대상기간 : ${period}`,
  ].join('\n');
}

function deliver(rec) {
  // TODO(사내 구축): 사내 메일 서버(SMTP) / SMS 게이트웨이 연동. DEMO는 기록만 한다.
  rec.status = 'DEMO_LOGGED';
  return rec;
}

/**
 * @param {object} p 프로젝트
 * @param {string} event 이벤트 코드
 * @param {string[]} roles 수신 역할
 * @param {{subject:string, body:string|function, sms:string}} msg  body가 함수면 (role)=>string
 */
function send(p, event, roles, msg, today) {
  const db = store.get();
  const settings = db.settings || {};
  const users = recipients(p, roles);
  const sent = [];
  const now = new Date().toISOString();
  for (const u of users) {
    const roleLine = typeof msg.body === 'function' ? msg.body(u.role) : msg.body;
    const body = `[재해예방 기술지도 관리시스템 자동안내]\n\n${roleLine}\n\n${projectSummary(p)}\n\n※ 본 메일은 시스템에서 자동 발송되었습니다.`;
    const base = { at: now, date: today, projectId: p.id, event, toUserId: u.id, toName: u.name, toRole: u.role, read: false };
    if (settings.notifyEmail !== false) {
      sent.push(deliver({ id: store.id('n'), ...base, channel: 'EMAIL', toAddr: u.email || '(이메일 미등록)', subject: `[기술지도] ${msg.subject} - ${p.name}`, body }));
    }
    if (settings.notifySms !== false) {
      const sms = typeof msg.sms === 'function' ? msg.sms(u.role) : msg.sms;
      sent.push(deliver({ id: store.id('n'), ...base, channel: 'SMS', toAddr: u.phone || '(휴대폰 미등록)', subject: msg.subject, body: `[기술지도] ${sms || msg.subject} / ${p.name}` }));
    }
  }
  db.notifications.push(...sent);
  const missingRoles = roles.filter((r) => !users.some((u) => u.role === r));
  return { count: users.length, recipients: users.map((u) => `${u.name}(${ROLE_LABEL[u.role]})`), missingRoles };
}

module.exports = { send, recipients, ROLE_LABEL, projectSummary };
