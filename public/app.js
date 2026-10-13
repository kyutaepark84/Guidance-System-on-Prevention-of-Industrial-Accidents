/* 재해예방 기술지도 관리시스템 (DEMO) - 프론트엔드 (빌드 없는 Vanilla JS) */
'use strict';

const S = { meta: null, user: null, cache: {} };
const $ = (sel, root = document) => root.querySelector(sel);
// 브라우저 저장소는 막혀 있을 수 있으므로 항상 예외 처리
const LS = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 무시 */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* 무시 */ } },
};
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ───────────── 유틸 ─────────────
function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const won = (n) => (n == null || n === '' ? '-' : Number(n).toLocaleString('ko-KR') + '원');
const eok = (n) => (n == null ? '-' : (Number(n) / 1e8).toFixed(2) + '억');
const roleLabel = (r) => (S.meta.roles[r] || (r === 'SYSTEM' ? '시스템' : r));
const today = () => S.meta.today;
function addDays(s, n) { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function diffDays(a, b) { return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 864e5); }
const isMine = (role) => S.user.role === 'ADMIN' || S.user.role === role;

function badge(text, color) { return `<span class="badge b-${color || 'gray'}">${esc(text)}</span>`; }
function statusBadge(p) { return badge(p.statusLabel, p.statusColor); }
function typeBadge(p) { return p.type === 'UNIT_PRICE' ? badge('단가계약', 'purple') : badge('일반공사', 'outline'); }
function judgeBadge(p) {
  if (!p.judgment) return '';
  if (p.judgment.target) return badge('기술지도 대상', 'red');
  if (p.judgment.warning) return badge('비대상(주의)', 'orange');
  return badge('비대상', 'gray');
}

async function api(method, url, body) {
  if (window.__TG_LOCAL) return window.__TG_LOCAL.api(method, url, body, S.user);
  const opt = { method, headers: {} };
  if (S.user) opt.headers['x-user-id'] = S.user.id;
  if (body instanceof FormData) opt.body = body;
  else if (body !== undefined) { opt.headers['content-type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const res = await fetch('/api' + url, opt);
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error((data && data.error) || `오류(${res.status})`);
  return data;
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toast-root').appendChild(el);
  setTimeout(() => el.remove(), kind === 'err' ? 6000 : 3500);
}

async function download(url, fallbackName) {
  if (window.__TG_LOCAL) {
    try { await window.__TG_LOCAL.download(url, S.user); } catch (e) { toast(e.message, 'err'); }
    return;
  }
  try {
    const res = await fetch('/api' + url, { headers: { 'x-user-id': S.user.id } });
    if (!res.ok) throw new Error((await res.json()).error);
    const blob = await res.blob();
    const cd = res.headers.get('content-disposition') || '';
    const m = /filename\*=UTF-8''([^;]+)/.exec(cd);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = m ? decodeURIComponent(m[1]) : fallbackName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  } catch (e) { toast(e.message, 'err'); }
}
window.dl = download;

function fileLink(f) {
  return `<a href="#" onclick="dl('/files/${esc(f.id)}','${esc(f.originalName).replace(/'/g, '')}');return false;" title="${esc(f.uploaderName || '')} ${esc((f.uploadedAt || '').slice(0, 10))}">📎 ${esc(f.originalName)}</a>`;
}

function modal(title, bodyHtml, { wide = false, onMount, footer } = {}) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-bg"><div class="modal" style="${wide ? 'max-width:1040px' : ''}">
    <div class="hd"><h3>${esc(title)}</h3><button class="x" data-close>×</button></div>
    <div class="bd">${bodyHtml}</div>${footer ? `<div class="ft">${footer}</div>` : ''}</div></div>`;
  const close = () => { root.innerHTML = ''; };
  $$('[data-close]', root).forEach((b) => b.addEventListener('click', close));
  $('.modal-bg', root).addEventListener('mousedown', (e) => { if (e.target.classList.contains('modal-bg')) close(); });
  if (onMount) onMount($('.modal', root), close);
  return close;
}

// ───────────── 라우팅 ─────────────
const NAV = [
  { href: '#/dashboard', icon: '🏠', label: '대시보드' },
  { href: '#/projects', icon: '📋', label: '기술지도 대상 공사 구분' },
  { href: '#/settlements', icon: '💰', label: '단가계약 정산·누계' },
  { href: '#/calendar', icon: '📅', label: '기술지도 일정' },
  { href: '#/notifications', icon: '✉️', label: '알림(메일·SMS)', badge: true },
  { sep: '안내' },
  { href: '#/flow', icon: '🔀', label: '업무 흐름(Flow)' },
  { href: '#/admin', icon: '⚙️', label: 'DEMO 운영·기준정보', admin: true },
];

// 사내 시스템 표준 화면(상단 GNB + 메뉴바 + 열린 화면 탭 + 포틀릿) 형태
// 사내 구축 시 회사 로고·명칭은 여기에서 설정한다(DEMO 공개 페이지에는 넣지 않음).
const BRAND = { company: '', logoHtml: '' };
const LOGO_SVG = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 2l8 3v6c0 5-3.4 9.3-8 11-4.6-1.7-8-6-8-11V5l8-3z" fill="none" stroke="#f37321" stroke-width="2"/><path d="M8 12l3 3 5-6" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

S.tabs = [];
function trackTab(title, tabLabel) {
  const key = S.route.split('?')[0];
  if (key === '#/dashboard') return;
  const label = tabLabel || title;
  const ex = S.tabs.find((t) => t.key === key);
  if (ex) { ex.route = S.route; ex.label = label; return; }
  S.tabs.push({ key, route: S.route, label });
  if (S.tabs.length > 9) S.tabs.shift();
}

function shell(title, inner, tabLabel) {
  const sim = S.meta.settings.demoToday;
  const users = S.meta.users.filter((u) => u.active !== false);
  const opts = Object.keys(S.meta.roles).map((r) => `<optgroup label="${esc(roleLabel(r))}">${users.filter((u) => u.role === r).map((u) => `<option value="${u.id}" ${u.id === S.user.id ? 'selected' : ''}>${esc(u.name)} · ${esc(orgName(u))}</option>`).join('')}</optgroup>`).join('');
  const route = S.route.split('?')[0].split('/').slice(0, 2).join('/');
  const curKey = S.route.split('?')[0];
  trackTab(title, tabLabel);
  const menus = NAV.filter((n) => !n.sep && (!n.admin || S.user.role === 'ADMIN'));
  return `<div class="srm">
    <header class="gnb">
      <div class="gnb-top">
        <a class="brand" href="#/dashboard">${BRAND.logoHtml || `<span class="brand-mark">${LOGO_SVG}</span>`}${BRAND.company ? `<span class="brand-co">${esc(BRAND.company)}</span><span class="brand-sep"></span>` : ''}<span class="brand-sys">재해예방 기술지도 관리시스템</span><span class="brand-demo">DEMO</span></a>
        <div class="gnb-right">
          <div class="menu-search"><input id="menu-search" list="menu-list" placeholder="메뉴검색" aria-label="메뉴검색"><datalist id="menu-list">${menus.map((n) => `<option value="${esc(n.label)}">`).join('')}</datalist><span class="ico">⌕</span></div>
          <span class="clock ${sim ? 'sim' : ''}" title="${sim ? '데모 기준일(시간 시뮬레이션) 적용 중' : '기준일'}">◷ ${esc(today())}</span>
          <span class="gnb-user">${esc(S.user.name)}</span>
          <select id="user-switch" class="gnb-select" aria-label="사용자 전환">${opts}</select>
          <button class="gnb-btn" id="logout" title="사용자 선택 화면">로그아웃</button>
        </div>
      </div>
      <nav class="gnb-menu">${menus.map((n) => `<a href="${n.href}" class="${route === n.href ? 'active' : ''}">${n.label}${n.badge ? '<span class="nav-badge" id="unread-badge" hidden></span>' : ''}</a>`).join('')}</nav>
    </header>
    <div class="tabbar">
      <span class="tab-edge">›</span>
      <a class="tab ${curKey === '#/dashboard' ? 'on' : ''}" href="#/dashboard">HOME</a>
      ${S.tabs.map((t, i) => `<span class="tab ${t.key === curKey ? 'on' : ''}"><a href="${esc(t.route)}">${esc(t.label)}</a><button class="tab-x" data-tab="${i}" title="닫기">×</button></span>`).join('')}
    </div>
    <div class="body-wrap">
      <aside class="quick" aria-hidden="true"><span>›</span><span>★</span></aside>
      <main class="content">
        <div class="page-title"><h2>${esc(title)}</h2><span class="crumb">HOME › ${esc(title)}</span></div>
        ${inner}
        <footer class="page-foot">${storageNote()}<span>DEMO 버전 — 실제 메일/SMS는 발송되지 않으며 '알림' 메뉴에 기록됩니다.</span></footer>
      </main>
    </div></div>`;
}

function storageNote() {
  const m = S.meta;
  if (m.readOnly) return '<div style="color:#f0a64b;margin-bottom:6px">읽기 전용으로 열림 — 데이터를 바꾸려면 편집 권한이 필요합니다.</div>';
  if (m.storageMode === 'shared') return '<div style="margin-bottom:6px">● 공유 데이터: 이 주소로 접속한 모든 사람이 같은 데이터를 봅니다.</div>';
  if (m.storageMode === 'local') return '<div style="margin-bottom:6px">● 이 브라우저에만 저장됩니다.</div>';
  return '';
}

function orgName(u) {
  const m = S.meta;
  return (m.departments.find((d) => d.id === u.orgId) || m.companies.find((c) => c.id === u.orgId) || m.agencies.find((a) => a.id === u.orgId) || { name: roleLabel(u.role) }).name;
}

function bindShell() {
  $('#user-switch').addEventListener('change', (e) => login(e.target.value, true));
  const ms = $('#menu-search');
  ms.addEventListener('change', () => {
    const q = ms.value.trim();
    const hit = NAV.find((n) => !n.sep && n.label.includes(q));
    if (q && hit) go(hit.href); else if (q) toast('일치하는 메뉴가 없습니다.', 'err');
  });
  $$('.tab-x').forEach((b) => b.addEventListener('click', (e) => {
    e.preventDefault();
    const i = Number(b.dataset.tab);
    const closing = S.tabs[i];
    S.tabs.splice(i, 1);
    if (closing && closing.key === S.route.split('?')[0]) go(S.tabs.length ? S.tabs[S.tabs.length - 1].route : '#/dashboard');
    else render();
  }));
  // 포틀릿 새로고침 버튼
  $$('.content .panel > .hd').forEach((hd) => {
    if (hd.querySelector('.portlet-tools')) return;
    const t = document.createElement('span');
    t.className = 'portlet-tools';
    t.innerHTML = '<button type="button" title="새로고침">↻</button>';
    t.querySelector('button').addEventListener('click', () => render());
    hd.appendChild(t);
  });
  $('#logout').addEventListener('click', () => { LS.del('tg_user'); S.user = null; render(); });
  api('GET', '/dashboard').then((d) => {
    const b = $('#unread-badge');
    if (b && d.unread) { b.textContent = d.unread; b.hidden = false; }
  }).catch(() => {});
}

async function login(uid, keepRoute) {
  S.user = S.meta.users.find((u) => u.id === uid) || null;
  if (S.user) LS.set('tg_user', uid);
  if (!keepRoute) S.route = '#/dashboard';
  render();
}

async function loadMeta() { S.meta = await api('GET', '/meta'); }

async function render() {
  const app = $('#app');
  if (!S.meta) await loadMeta();
  if (!S.user) { app.innerHTML = loginView(); bindLogin(); return; }
  const [, page, id] = (S.route || '#/dashboard').split('?')[0].split('/');
  const pages = { dashboard: pageDashboard, projects: id ? () => pageProject(id) : pageProjects, settlements: pageSettlements, calendar: pageCalendar, notifications: pageNotifications, flow: pageFlow, admin: pageAdmin };
  const fn = pages[page] || pageDashboard;
  try {
    await fn();
  } catch (e) {
    app.innerHTML = shell('오류', `<div class="alert danger">${esc(e.message)}</div>`);
    bindShell();
  }
}
// 화면 이동: 내부 라우팅(S.route). 서버 실행 시 주소창 해시도 함께 갱신한다.
S.route = (!window.__TG_LOCAL && location.hash.startsWith('#/')) ? location.hash : '#/dashboard';
function go(route) {
  S.route = route;
  if (!window.__TG_LOCAL) { try { history.replaceState(null, '', route); } catch { /* 무시 */ } }
  $('#modal-root').innerHTML = '';
  render();
  window.scrollTo(0, 0);
}
window.go = go;
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="#/"]');
  if (a) { e.preventDefault(); go(a.getAttribute('href')); }
});

// 브라우저 confirm()을 쓰지 않는 확인 창
function askConfirm(message, okLabel = '확인') {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    modal('확인', `<div style="line-height:1.6">${esc(message)}</div>`, {
      footer: `<button class="btn" data-close>취소</button><button class="btn primary" id="confirm-ok">${esc(okLabel)}</button>`,
      onMount(el, close) {
        $('#confirm-ok', el).addEventListener('click', () => { finish(true); close(); });
        new MutationObserver((m, obs) => { if (!el.isConnected) { obs.disconnect(); finish(false); } }).observe($('#modal-root'), { childList: true });
      },
    });
  });
}

// ───────────── 로그인(DEMO 사용자 선택) ─────────────
function loginView() {
  if (!S.meta.users.length) {
    return `<div class="login"><h1>재해예방 기술지도 관리시스템 <span class="badge b-orange">DEMO</span></h1>
      <div class="panel"><div class="hd"><h3>아직 데이터가 없습니다</h3></div><div class="bd">
        <div class="desc">시연용 기준정보(부서·협력업체·기술지도기관·사용자)와 진행 단계가 다른 샘플 공사 9건을 만들어 바로 테스트를 시작할 수 있습니다. 업체·기관·인물은 모두 가상입니다.</div>
        <button class="btn primary" id="setup-seed">시연 데이터 만들기</button></div></div></div>`;
  }
  const groups = Object.keys(S.meta.roles).map((r) => {
    const us = S.meta.users.filter((u) => u.role === r && u.active !== false);
    if (!us.length) return '';
    return `<div class="role-group"><h4>${esc(roleLabel(r))}</h4><div class="user-cards">${us.map((u) => `<div class="user-card" data-uid="${u.id}"><b>${esc(u.name)}</b><span>${esc(orgName(u))} · ${esc(u.title || '')}</span></div>`).join('')}</div></div>`;
  }).join('');
  return `<div class="login"><h1>재해예방 기술지도 관리시스템 <span class="badge b-orange">DEMO</span></h1>
    <div class="desc">공사(일반·단가계약)의 기술지도 대상여부를 자동 판정하고, 협력업체 관리부서 · 안전보건환경부서 · 기술지도기관 · 협력업체 · 구매부서가
    업무 흐름(상태)에 따라 각자의 업무를 수행하도록 지원합니다.<br><b>테스트할 사용자(역할)를 선택하세요.</b> 상단에서 언제든 사용자를 전환할 수 있습니다.</div>
    ${S.meta.storageMode === 'local' ? '<div class="alert warn">이 주소에서는 데이터가 <b>지금 사용하는 브라우저에만</b> 저장됩니다. 다른 사람·다른 PC와 데이터가 공유되지 않으며, 브라우저 기록을 지우면 시연 데이터로 다시 시작합니다. 첨부파일은 목록만 기록됩니다.</div>' : ''}${groups}</div>`;
}
function bindLogin() {
  $$('.user-card').forEach((c) => c.addEventListener('click', () => login(c.dataset.uid)));
  const b = $('#setup-seed');
  if (b) b.addEventListener('click', async () => {
    b.disabled = true;
    try { await api('POST', '/setup/seed'); await loadMeta(); render(); } catch (e) { toast(e.message, 'err'); b.disabled = false; }
  });
}

// ───────────── 대시보드 ─────────────
async function pageDashboard() {
  const d = await api('GET', '/dashboard');
  const st = S.meta.status;
  const k = (key, label) => `<div class="kpi" onclick="go('#/projects?status=${key}')\"><div class="k">${label}</div><div class="v">${d.counts[key] || 0}</div></div>`;
  const tasks = d.myTasks.length
    ? `<ul class="list">${d.myTasks.map((t) => `<li><span>${t.urgent ? '🔴' : '🟡'}</span><div class="grow"><a href="#/projects/${t.projectId}"><b>${esc(t.label)}</b></a><div class="small muted">${esc(t.projectName)} · ${badge(st[t.status]?.label, st[t.status]?.color)}${S.user.role === 'ADMIN' ? ` · 담당: ${esc(roleLabel(t.role))}` : ''}</div></div></li>`).join('')}</ul>`
    : '<div class="empty">처리할 업무가 없습니다 👍</div>';
  const alerts = d.alerts.length ? d.alerts.map((a) => `<div class="alert ${a.level}">⚠️ <div><a href="#/projects/${a.projectId}"><b>${esc(a.projectName)}</b></a><br>${esc(a.text)}</div></div>`).join('') : '<div class="alert ok">✅ 누락 위험 경보가 없습니다.</div>';
  const up = d.upcoming.length ? `<table class="tbl"><thead><tr><th>지도일</th><th>공사</th><th>회차</th><th>기관</th></tr></thead><tbody>${d.upcoming.map((u) => `<tr class="click" onclick="go('#/projects/${u.projectId}')\"><td class="nowrap">${esc(u.date)} ${esc(u.time || '')} <span class="small muted">D${diffDays(today(), u.date) >= 0 ? '-' + diffDays(today(), u.date) : '+' + -diffDays(today(), u.date)}</span></td><td>${esc(u.projectName)}</td><td>${u.round}회</td><td class="small">${esc(u.agency || '')}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">예정된 기술지도가 없습니다.</div>';
  const lc = d.lastDailyCheck;
  $('#app').innerHTML = shell('대시보드', `
    <div class="alert info">👤 <div><b>${esc(S.user.name)}</b> (${esc(roleLabel(S.user.role))} · ${esc(orgName(S.user))}) 로 접속 중입니다. ${roleHelp(S.user.role)}</div></div>
    <div class="kpis">
      <div class="kpi accent" onclick="go('#/projects')\"><div class="k">전체 공사</div><div class="v">${d.total}</div></div>
      ${k('MONITORING', '단가 누계관리')}${k('DOCS_REQUESTED', st.DOCS_REQUESTED.label)}${k('DOCS_SUBMITTED', st.DOCS_SUBMITTED.label)}${k('ACTIVE', st.ACTIVE.label)}${k('EXTENSION', st.EXTENSION.label)}${k('CLOSED', st.CLOSED.label)}
    </div>
    <div class="grid g2">
      <div class="panel"><div class="hd"><h3>내가 처리할 업무</h3><span class="sub">${d.myTasks.length}건</span></div><div class="bd np">${tasks}</div></div>
      <div class="panel"><div class="hd"><h3>누락 위험 경보</h3><span class="sub">주기·만료·누계</span></div><div class="bd">${alerts}</div></div>
    </div>
    <div class="grid g2">
      <div class="panel"><div class="hd"><h3>다가오는 기술지도</h3></div><div class="bd np">${up}</div></div>
      <div class="panel"><div class="hd"><h3>자동 점검(스케줄러)</h3><span class="sub">매일 자동 실행</span></div><div class="bd">
        ${lc ? `<div class="small muted">최근 실행: ${esc(lc.date)} (${esc(new Date(lc.at).toLocaleString('ko-KR'))})</div>${lc.results.length ? `<ul>${lc.results.map((r) => `<li class="small">${esc(r)}</li>`).join('')}</ul>` : '<div class="small">신규 발송 대상 없음</div>'}` : '실행 이력 없음'}
        <div class="small muted" style="margin-top:8px">점검 항목: 기간 만료 D-${S.meta.settings.endNoticeDays} 안내 · 기술지도 ${S.meta.settings.cycleDays}일 주기 점검 · 결과 미제출 · 단가계약 누계(${Math.round(S.meta.settings.warnRatio * 100)}%) 주의</div>
      </div></div>
    </div>`);
  bindShell();
}

function roleHelp(role) {
  return {
    PURCHASE: '공사 계약서를 Upload 하여 공사를 등록하고, 연장 시 갱신 계약서를 제출합니다.',
    PARTNER_MGMT: '담당 공사의 기술지도 진행을 관리하고, 현장 완료 시 종결 · 필요 시 연장을 요청합니다.',
    SAFETY: '전체 기술지도 현황을 모니터링하고, 기술지도 계약서·노동부 제출 여부를 확인합니다.',
    AGENCY: '자료 검토 후 기술지도 계약서를 제출하고, 지도일 선택 · 결과 제출 · 보완사항 검토를 수행합니다.',
    CONTRACTOR: '관련자료 제출, 월별 작업일자 지정, 미비점 개선결과 보고를 수행합니다.',
    ADMIN: '모든 역할의 작업을 수행할 수 있으며, 데모 기준일 변경 등 DEMO 운영 기능을 사용할 수 있습니다.',
  }[role] || '';
}

// ───────────── 공사 목록(대상 공사 구분) ─────────────
async function pageProjects() {
  const list = await api('GET', '/projects');
  const q = new URLSearchParams((S.route.split('?')[1]) || '');
  const f = { type: q.get('type') || '', judge: q.get('judge') || '', status: q.get('status') || '', kw: q.get('kw') || '' };
  const canCreate = ['PURCHASE', 'ADMIN'].includes(S.user.role);
  $('#app').innerHTML = shell('재해예방 기술지도 대상 공사 구분', `
    <div class="panel">
      <div class="hd"><h3>공사 목록</h3><span class="sub" id="cnt"></span>
        <div class="right">
          <button class="btn" id="export">⬇ 엑셀</button>
          ${canCreate ? '<button class="btn primary" id="new">＋ 신규 공사 등록</button>' : ''}
        </div></div>
      <div class="bd" style="border-bottom:1px solid var(--line-2)"><div class="filters">
        <select id="f-type"><option value="">구분 전체</option><option value="GENERAL">일반공사</option><option value="UNIT_PRICE">단가계약</option></select>
        <select id="f-judge"><option value="">판정 전체</option><option value="Y">기술지도 대상</option><option value="N">비대상</option><option value="W">비대상(주의)</option></select>
        <select id="f-status"><option value="">상태 전체</option>${Object.entries(S.meta.status).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('')}</select>
        <input id="f-kw" placeholder="공사명·업체명·계약번호 검색" style="min-width:240px">
      </div></div>
      <div class="bd np tbl-wrap" id="tbl"></div>
    </div>
    <div class="small muted">판정기준 — 일반공사: 공사기간 ${S.meta.settings.periodMonths}개월 이상 &amp; 공사금액 ${eok(S.meta.settings.amountThreshold)} 이상 / 단가계약: 계약금액 ${eok(S.meta.settings.amountThreshold)} 이상, 또는 연간 누적 정산금액 ${eok(S.meta.settings.amountThreshold)} 이상</div>`);
  bindShell();
  $('#f-type').value = f.type; $('#f-judge').value = f.judge; $('#f-status').value = f.status; $('#f-kw').value = f.kw;
  const draw = () => {
    const ft = $('#f-type').value, fj = $('#f-judge').value, fs = $('#f-status').value, kw = $('#f-kw').value.trim().toLowerCase();
    const rows = list.filter((p) => (!ft || p.type === ft) && (!fs || p.status === fs)
      && (!fj || (fj === 'Y' ? p.judgment?.target : fj === 'W' ? (!p.judgment?.target && p.judgment?.warning) : !p.judgment?.target))
      && (!kw || `${p.name} ${p.companyName} ${p.contractNo}`.toLowerCase().includes(kw)));
    $('#cnt').textContent = `${rows.length}건`;
    $('#tbl').innerHTML = rows.length ? `<table class="tbl"><thead><tr>
      <th>구분</th><th>공사계약명 / 계약번호</th><th>업체명</th><th>계약기간</th><th class="num">계약금액</th><th class="num">누계 정산(당해)</th><th>판정결과</th><th>진행상태</th><th>현재 담당</th><th>다음 지도기한</th></tr></thead><tbody>
      ${rows.map((p) => {
        const cum = p.judgment?.cumulative;
        const ratio = p.judgment?.ratio || 0;
        const owner = [...new Set(p.tasks.map((t) => roleLabel(t.role)))].join(', ');
        const c = p.cycle;
        return `<tr class="click" data-id="${p.id}">
        <td>${typeBadge(p)}</td>
        <td><b>${esc(p.name)}</b><div class="small muted">${esc(p.contractNo || '-')} · ${esc(p.deptName || '')}</div></td>
        <td>${esc(p.companyName)}</td>
        <td class="nowrap small">${esc(p.startDate)}<br>~ ${esc(p.endDate)}</td>
        <td class="num">${won(p.amount)}</td>
        <td class="num">${p.type === 'UNIT_PRICE' ? `${won(cum?.currentYearAmount || 0)}<div class="bar ${ratio >= 1 ? 'over' : p.judgment?.warning ? 'warn' : ''}" style="margin-top:4px"><i style="width:${Math.min(100, ratio * 100)}%"></i></div><span class="small muted">${(ratio * 100).toFixed(1)}%</span>` : '<span class="muted">-</span>'}</td>
        <td>${judgeBadge(p)}</td>
        <td>${statusBadge(p)}</td>
        <td class="small">${esc(owner || '-')}</td>
        <td class="small nowrap">${c ? `${esc(c.nextDue)} ${c.level === 'overdue' ? badge('초과', 'red') : c.level === 'warn' ? badge('임박', 'orange') : ''}` : '-'}</td></tr>`;
      }).join('')}</tbody></table>` : '<div class="empty">조건에 맞는 공사가 없습니다.</div>';
    $$('#tbl tr[data-id]').forEach((tr) => tr.addEventListener('click', () => { go(`#/projects/${tr.dataset.id}`); }));
  };
  ['#f-type', '#f-judge', '#f-status'].forEach((s) => $(s).addEventListener('change', draw));
  $('#f-kw').addEventListener('input', draw);
  draw();
  $('#export').addEventListener('click', () => download('/export/projects.xlsx', '기술지도_대상공사.xlsx'));
  if (canCreate) $('#new').addEventListener('click', openRegister);
}

// 신규 공사 등록: ① 계약서 Upload → ② 자동 추출 확인/수정 → ③ 등록(자동 판정·안내)
function openRegister() {
  let token = null;
  let extracted = { fields: {}, evidence: {} };
  const m = S.meta;
  const deptOpts = m.departments.filter((d) => d.kind === 'PARTNER_MGMT').map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('');
  const body = `
    <div id="reg-step1">
      <div class="dropzone" id="dz"><div style="font-size:28px">📄</div><b>공사 계약서 파일을 끌어다 놓거나 클릭하여 선택</b>
        <div class="small muted" style="margin-top:6px">PDF(텍스트) · DOCX · HWPX · XLSX · TXT 지원 — 계약서에서 공사계약명/업체명/계약기간/계약금액을 자동 추출합니다.</div>
        <input type="file" id="cfile" hidden accept=".pdf,.docx,.hwpx,.hwp,.xlsx,.txt"></div>
      <div style="text-align:center;margin-top:10px"><a href="#" id="manual">계약서 없이 직접 입력하기</a></div>
    </div>
    <div id="reg-step2" style="display:none">
      <div id="extract-msg"></div>
      <div class="form">
        <label class="req">공사 구분</label><div><select id="r-type"><option value="GENERAL">일반공사</option><option value="UNIT_PRICE">단가계약</option></select><div class="evidence" id="ev-type"></div></div>
        <label class="req">공사계약명</label><div><input id="r-name"><div class="evidence" id="ev-name"></div></div>
        <label>계약번호</label><div><input id="r-contractNo"><div class="evidence" id="ev-contractNo"></div></div>
        <label class="req">업체명</label><div><input id="r-companyName" list="comp-list"><datalist id="comp-list">${m.companies.map((c) => `<option value="${esc(c.name)}">`).join('')}</datalist><div class="evidence" id="ev-companyName"></div></div>
        <label class="req">계약기간</label><div><div class="btn-row"><input type="date" id="r-startDate"> ~ <input type="date" id="r-endDate"></div><div class="evidence" id="ev-period"></div></div>
        <label class="req">계약금액(원)</label><div><input id="r-amount" inputmode="numeric"><div class="field-note" id="amt-kor"></div><div class="evidence" id="ev-amount"></div></div>
        <label>작업장소(사업장)</label><input id="r-workPlace" placeholder="예: 1공장, No.2 NCC">
        <label>협력업체 관리부서</label><div class="btn-row"><select id="r-deptId"><option value="">선택</option>${deptOpts}</select><select id="r-managerUserId"><option value="">담당자 선택</option></select></div>
        <label>기술지도기관</label><div><select id="r-agencyId"><option value="">(기본 기관: ${esc(m.agencies.find((a) => a.id === m.settings.defaultAgencyId)?.name || '미지정')})</option>${m.agencies.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select><div class="field-note">대상 판정 시 기관에 자동 안내됩니다. 나중에 지정할 수도 있습니다.</div></div>
      </div>
      <div id="preview"></div>
      <details style="margin-top:12px"><summary class="small muted">추출된 계약서 텍스트 보기</summary><pre class="mail-body" id="raw" style="max-height:220px;overflow:auto"></pre></details>
    </div>`;
  modal('신규 공사 등록', body, {
    wide: true,
    footer: '<button class="btn" data-close>취소</button><button class="btn primary" id="reg-save" style="display:none">등록 및 대상여부 판정</button>',
    onMount(el, close) {
      const dz = $('#dz', el), fi = $('#cfile', el);
      const showStep2 = () => { $('#reg-step1', el).style.display = 'none'; $('#reg-step2', el).style.display = ''; $('#reg-save', el).style.display = ''; };
      const fill = () => {
        const f = extracted.fields || {}, ev = extracted.evidence || {};
        for (const k of ['name', 'contractNo', 'companyName', 'startDate', 'endDate', 'amount']) {
          const inp = $(`#r-${k}`, el);
          if (f[k] != null) { inp.value = k === 'amount' ? Number(f[k]).toLocaleString('ko-KR') : f[k]; inp.classList.add('hl'); }
        }
        if (f.type) { $('#r-type', el).value = f.type; if (ev.type) $('#r-type', el).classList.add('hl'); }
        for (const k of ['name', 'contractNo', 'companyName', 'period', 'amount', 'type']) if (ev[k]) $(`#ev-${k}`, el).textContent = `근거: ${ev[k]}`;
        $('#raw', el).textContent = extracted.textPreview || '(없음)';
        const miss = (extracted.missing || []).map((k) => ({ name: '공사계약명', companyName: '업체명', startDate: '계약 시작일', endDate: '계약 종료일', amount: '계약금액' }[k]));
        $('#extract-msg', el).innerHTML = extracted.warning ? `<div class="alert warn">${esc(extracted.warning)}</div>`
          : token ? `<div class="alert ${miss.length ? 'warn' : 'ok'}">${miss.length ? `일부 항목을 찾지 못했습니다: <b>${esc(miss.join(', '))}</b> — 직접 입력해 주세요.` : '계약서에서 필요 정보를 추출했습니다.'} <span class="small">(노란색 = 자동 추출값, 반드시 확인 후 등록)</span></div>` : '';
        preview();
      };
      const preview = () => {
        const amount = Number($('#r-amount', el).value.replace(/[^\d]/g, ''));
        $('#amt-kor', el).textContent = amount ? `${eok(amount)} (${amount.toLocaleString('ko-KR')}원)` : '';
        const s = $('#r-startDate', el).value, e = $('#r-endDate', el).value, t = $('#r-type', el).value;
        const th = m.settings.amountThreshold;
        if (!s || !e || !amount) { $('#preview', el).innerHTML = ''; return; }
        const addM = (d, n) => { const x = new Date(d + 'T00:00:00Z'); const day = x.getUTCDate(); x.setUTCDate(1); x.setUTCMonth(x.getUTCMonth() + n); const last = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate(); x.setUTCDate(Math.min(day, last)); return x.toISOString().slice(0, 10); };
        const pOk = addDays(addM(s, m.settings.periodMonths), -1) <= e;
        let html;
        if (t === 'GENERAL') {
          const ok = pOk && amount >= th;
          html = `<div class="alert ${ok ? 'danger' : 'ok'}"><b>판정 미리보기: ${ok ? '기술지도 대상' : '대상 아님'}</b> — 공사기간 ${pOk ? '1개월 이상 ✔' : '1개월 미만 ✖'}, 공사금액 ${amount >= th ? '1억 이상 ✔' : '1억 미만 ✖'}</div>`;
        } else {
          html = amount >= th ? `<div class="alert danger"><b>판정 미리보기: 기술지도 대상</b> — 단가계약 계약금액 1억원 이상</div>`
            : `<div class="alert info"><b>판정 미리보기: 대상 아님(누계 관리)</b> — 계약금액 1억원 미만. 월별 정산실적 Upload 시 연간 누계 1억원 이상이면 자동으로 대상 전환됩니다.</div>`;
        }
        $('#preview', el).innerHTML = html;
      };
      const analyze = async (file) => {
        dz.innerHTML = '<div style="font-size:28px">⏳</div><b>계약서 분석 중...</b>';
        const fd = new FormData(); fd.append('file', file);
        try {
          extracted = await api('POST', '/contracts/analyze', fd);
          token = extracted.token;
          showStep2(); fill();
          $('#extract-msg', el).insertAdjacentHTML('afterbegin', `<div class="small muted" style="margin-bottom:6px">📎 ${esc(extracted.fileName)}</div>`);
        } catch (e) { toast(e.message, 'err'); close(); }
      };
      dz.addEventListener('click', () => fi.click());
      fi.addEventListener('change', () => fi.files[0] && analyze(fi.files[0]));
      dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
      dz.addEventListener('dragleave', () => dz.classList.remove('over'));
      dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('over'); if (e.dataTransfer.files[0]) analyze(e.dataTransfer.files[0]); });
      $('#manual', el).addEventListener('click', (e) => { e.preventDefault(); showStep2(); fill(); });
      ['#r-amount', '#r-startDate', '#r-endDate', '#r-type'].forEach((s) => $(s, el).addEventListener('input', preview));
      $('#r-type', el).addEventListener('change', preview);
      $('#r-amount', el).addEventListener('blur', (e) => { const n = Number(e.target.value.replace(/[^\d]/g, '')); if (n) e.target.value = n.toLocaleString('ko-KR'); });
      $('#r-deptId', el).addEventListener('change', (e) => {
        $('#r-managerUserId', el).innerHTML = '<option value="">담당자 선택</option>' + m.users.filter((u) => u.role === 'PARTNER_MGMT' && u.orgId === e.target.value).map((u) => `<option value="${u.id}">${esc(u.name)} (${esc(u.title || '')})</option>`).join('');
      });
      $('#reg-save', el).addEventListener('click', async () => {
        const fd = new FormData();
        for (const k of ['type', 'name', 'contractNo', 'companyName', 'startDate', 'endDate', 'amount', 'workPlace', 'deptId', 'managerUserId', 'agencyId']) fd.append(k, $(`#r-${k}`, el).value.trim());
        if (token) fd.append('token', token);
        try {
          const p = await api('POST', '/projects', fd);
          close();
          toast(p.judgment.target ? `등록 완료 — 기술지도 대상으로 판정되어 관계자에게 자동 안내를 발송했습니다.` : `등록 완료 — ${p.statusLabel}`, 'ok');
          go(`#/projects/${p.id}`);
        } catch (e) { toast(e.message, 'err'); }
      });
    },
  });
}

// ───────────── 공사 상세 ─────────────
const STEPS = [
  { key: 1, label: '공사 등록·판정', who: '구매/시스템' },
  { key: 3, label: '관련자료 제출', who: '협력업체' },
  { key: 4, label: '기술지도 계약서', who: '기술지도기관' },
  { key: 5, label: '기술지도 진행', who: '기관·협력업체' },
  { key: 6, label: '기간 연장', who: '구매·협력업체·기관', optional: true },
  { key: 7, label: '종결', who: '협력업체 관리부서' },
];

function stepper(p) {
  if (p.status === 'NOT_TARGET' || p.status === 'MONITORING') {
    return `<div class="stepper"><div class="step cur"><div class="dot">✓</div><div class="lb">공사 등록·판정</div><div class="who">${p.status === 'MONITORING' ? '누계 관리 중' : '대상 아님'}</div></div></div>`;
  }
  const cur = p.step;
  const extended = (p.extensions || []).length > 0 || p.status === 'EXTENSION';
  return `<div class="stepper">${STEPS.map((s) => {
    let cls = s.key < cur ? 'done' : s.key === cur ? 'cur' : '';
    if (s.key === 6 && !extended && cur !== 6) cls = cur > 6 ? 'skip' : 'skip';
    if (s.key === 6 && extended && cur !== 6) cls = 'done';
    if (cur === 7 && s.key === 7) cls = 'done cur';
    return `<div class="step ${cls}"><div class="dot">${cls.includes('done') ? '✓' : STEPS.indexOf(s) + 1}</div><div class="lb">${s.label}${s.optional ? ' (필요시)' : ''}</div><div class="who">${s.who}</div></div>`;
  }).join('')}</div>`;
}

async function pageProject(id) {
  const p = await api('GET', `/projects/${id}`);
  S.cache.project = p;
  const m = S.meta;
  const fby = (cat) => p.files.filter((f) => f.category === cat);
  const contractFile = p.files.find((f) => f.id === p.contractFileId);
  const j = p.judgment || {};

  const info = `<dl class="kv kv-4">
    <dt>계약번호</dt><dd>${esc(p.contractNo || '-')}</dd>
    <dt>업체명</dt><dd>${esc(p.companyName)}</dd>
    <dt>계약기간</dt><dd>${esc(p.startDate)} ~ ${esc(p.endDate)} <span class="small muted">(${diffDays(p.startDate, p.endDate) + 1}일)</span></dd>
    <dt>계약금액</dt><dd>${won(p.amount)}</dd>
    <dt>담당부서</dt><dd>${esc(p.deptName || '-')} ${p.managerName ? `· ${esc(p.managerName)}` : ''}</dd>
    <dt>기술지도기관</dt><dd>${esc(p.agencyName || '미지정')}</dd>
    <dt>작업장소</dt><dd>${esc(p.workPlace || '-')}</dd>
    <dt>공사 계약서</dt><dd>${contractFile ? fileLink(contractFile) : '<span class="muted">-</span>'}</dd>
    ${p.guidancePeriod ? `<dt>기술지도 대상기간</dt><dd><b>${esc(p.guidancePeriod.start)} ~ ${esc(p.guidancePeriod.end)}</b></dd>` : ''}
    ${p.tgContract ? `<dt>기술지도 계약</dt><dd>${esc(p.tgContract.contractDate)} 체결 · 예정 ${p.tgContract.plannedCount}회 ${p.tgContract.moelSubmittedDate ? `· 노동부 제출 ${esc(p.tgContract.moelSubmittedDate)}` : ''}</dd>` : ''}
    ${p.safetyCheck ? `<dt>안전보건 확인</dt><dd>✅ ${esc(p.safetyCheck.at)} ${esc(p.safetyCheck.by)} ${esc(p.safetyCheck.note)}</dd>` : ''}
    ${p.closed ? `<dt>종결</dt><dd>현장공사 완료 ${esc(p.closed.completionDate)} (${esc(p.closed.by)})</dd>` : ''}
  </dl>`;

  // 판정 패널
  let judgeHtml = `<div class="alert ${j.target ? 'danger' : j.warning ? 'warn' : 'ok'}"><div><b>${j.target ? '재해예방 기술지도 대상' : '기술지도 대상 아님'}</b><br><span class="small">${esc(j.reason || '')}</span><div class="small muted">판정일 ${esc(j.judgedAt || '')}</div></div></div>`;
  if (p.type === 'UNIT_PRICE') {
    const th = m.settings.amountThreshold;
    const yr = j.cumulative?.currentYear || today().slice(0, 4);
    const cum = j.cumulative?.currentYearAmount || 0;
    const ratio = cum / th;
    const months = {};
    for (const s of p.settlements) if (s.month.startsWith(yr)) months[s.month.slice(5)] = s.amount;
    judgeHtml += `<div class="small" style="margin:8px 0 4px"><b>${yr}년 누적 정산금액</b> ${won(cum)} / 기준 ${won(th)} (${(ratio * 100).toFixed(1)}%)${j.forecast ? ` · 연말 예상 ${won(j.forecast)}` : ''}</div>
      <div class="bar ${ratio >= 1 ? 'over' : j.warning ? 'warn' : ''}"><i style="width:${Math.min(100, ratio * 100)}%"></i></div>
      <div class="tbl-wrap" style="margin-top:10px"><table class="tbl small"><thead><tr>${Array.from({ length: 12 }, (_, i) => `<th class="num">${i + 1}월</th>`).join('')}</tr></thead><tbody><tr>${Array.from({ length: 12 }, (_, i) => { const v = months[String(i + 1).padStart(2, '0')]; return `<td class="num">${v != null ? (v / 1e4).toLocaleString('ko-KR') : '<span class="muted">-</span>'}</td>`; }).join('')}</tr></tbody></table><div class="small muted">단위: 만원 · 정산실적은 '단가계약 정산·누계' 메뉴에서 Upload</div></div>`;
  }

  // 할 일
  const tasksHtml = p.tasks.length ? p.tasks.map((t) => `<div class="task ${isMine(t.role) ? 'mine' : ''} ${t.urgent ? 'urgent' : ''}">${badge(roleLabel(t.role), isMine(t.role) ? 'orange' : 'gray')}<span class="t">${esc(t.label)}</span></div>`).join('')
    : `<div class="muted small">${p.status === 'CLOSED' ? '종결된 공사입니다.' : p.status === 'NOT_TARGET' ? '기술지도 대상이 아닙니다.' : '대기 중인 업무가 없습니다.'}</div>`;

  // 주기
  const c = p.cycle;
  const cycleHtml = c ? `<div class="alert ${c.level === 'overdue' || c.level === 'expired' ? 'danger' : c.level === 'warn' ? 'warn' : 'ok'}"><div>
    <b>기술지도 주기(${m.settings.cycleDays}일 1회) 점검</b><br>
    <span class="small">직전 지도 ${esc(c.last || '없음(개시일 ' + c.anchor + ')')} → 다음 지도 기한 <b>${esc(c.nextDue)}</b> (${c.daysLeft >= 0 ? `D-${c.daysLeft}` : `${-c.daysLeft}일 초과`})<br>
    예정 지도일 ${esc(c.upcoming || '미지정')} · 기간 만료 ${c.endIn >= 0 ? `D-${c.endIn}` : `${-c.endIn}일 경과`}</span></div></div>` : '';

  const visits = (p.visits || []).filter((v) => v.status !== 'CANCELED' || true);
  const held = visits.filter((v) => ['DONE', 'IMPROVEMENT_REQUESTED', 'IMPROVEMENT_SUBMITTED', 'CLOSED_OK'].includes(v.status)).length;
  const visitsHtml = visits.length ? `<table class="tbl"><thead><tr><th>회차</th><th>지도일</th><th>상태</th><th>지도내용 / 보완요구</th><th>첨부</th></tr></thead><tbody>${visits.map((v) => {
    const vf = p.files.filter((f) => f.ref === v.id);
    const vc = { SCHEDULED: 'blue', DONE: 'green', IMPROVEMENT_REQUESTED: 'orange', IMPROVEMENT_SUBMITTED: 'purple', CLOSED_OK: 'green', CANCELED: 'gray' }[v.status];
    return `<tr><td class="nowrap">${v.round}회차</td><td class="nowrap">${esc(v.actualDate || v.plannedDate)} ${esc(v.time || '')}<div class="small muted">${esc(v.inspector || '')}</div></td>
      <td>${badge(m.visitStatus[v.status], vc)}${v.moelReported ? '<div class="small muted">노동부 제출</div>' : ''}</td>
      <td class="small">${esc(v.summary || (v.status === 'CANCELED' ? '취소: ' + (v.cancelNote || '') : '-'))}
        ${v.findings ? `<div style="color:var(--orange);margin-top:4px">⚠ 보완요구: ${esc(v.findings)} (기한 ${esc(v.improveDue)})</div>` : ''}
        ${(v.improvements || []).map((i) => `<div style="margin-top:4px">↳ 개선보고(${esc(i.at)}): ${esc(i.note)}</div>`).join('')}
        ${(v.reviews || []).map((r) => `<div style="margin-top:4px">↳ 기관검토(${esc(r.at)}): ${r.ok ? '확인 완료' : '재보완 — ' + esc(r.note)}</div>`).join('')}</td>
      <td class="chip-files">${vf.map(fileLink).join('')}</td></tr>`;
  }).join('')}</tbody></table>` : '<div class="empty">기술지도 이력이 없습니다.</div>';

  const docTypes = m.settings.docTypes;
  const docsHtml = `<table class="tbl"><thead><tr><th>구분</th><th>파일</th></tr></thead><tbody>
    ${docTypes.map((d) => { const fs = p.files.filter((f) => f.ref === 'DOCS' && f.category === d.key); return `<tr><td class="nowrap">${esc(d.label)} ${d.required ? '<span class="small" style="color:var(--red)">필수</span>' : ''}</td><td class="chip-files">${fs.length ? fs.map(fileLink).join('') : '<span class="muted small">미제출</span>'}</td></tr>`; }).join('')}
    <tr><td>기술지도 계약서</td><td class="chip-files">${fby('TG_CONTRACT').map(fileLink).join('') || '<span class="muted small">-</span>'}</td></tr>
    ${p.files.some((f) => f.category.startsWith('EXT')) ? `<tr><td>연장 관련서류</td><td class="chip-files">${p.files.filter((f) => f.category.startsWith('EXT')).map(fileLink).join('')}</td></tr>` : ''}
  </tbody></table>`;

  const hist = `<ul class="timeline">${[...(p.history || [])].reverse().map((h) => `<li class="${h.role === 'SYSTEM' ? 'sys' : ''}"><b>${esc(h.label)}</b><div class="meta">${esc(h.date)} · ${esc(h.userName)} (${esc(roleLabel(h.role))})</div>${h.note ? `<div class="note">${esc(h.note)}</div>` : ''}</li>`).join('')}</ul>`;

  const notis = p.notifications.filter((n) => n.channel === 'EMAIL');
  const notiHtml = notis.length ? `<ul class="list">${notis.slice(0, 40).map((n) => `<li><span>✉️</span><div class="grow"><div><b>${esc(n.subject)}</b></div><div class="small muted">${esc(n.date)} → ${esc(n.toName)} (${esc(roleLabel(n.toRole))}) ${esc(n.toAddr)} · SMS 동시발송</div><details><summary class="small">내용</summary><div class="mail-body">${esc(n.body)}</div></details></div></li>`).join('')}</ul>` : '<div class="empty">발송 내역이 없습니다.</div>';

  $('#app').innerHTML = shell('공사 상세', `
    <div style="margin-bottom:12px"><a href="#/projects">← 공사 목록</a></div>
    <div class="panel">
      <div class="hd" style="flex-wrap:wrap">${typeBadge(p)}<h3 style="font-size:17px">${esc(p.name)}</h3>${statusBadge(p)}${judgeBadge(p)}</div>
      ${stepper(p)}
      <div class="bd">${info}</div>
    </div>
    <div class="grid g-side">
      <div>
        <div class="panel"><div class="hd"><h3>처리할 업무</h3><span class="sub">노란색 = 현재 사용자(${esc(roleLabel(S.user.role))}) 담당</span></div><div class="bd">${tasksHtml}</div></div>
        <div id="actions"></div>
        ${['ACTIVE', 'EXTENSION', 'CLOSED'].includes(p.status) ? `<div class="panel"><div class="hd"><h3>기술지도 일정·결과</h3><span class="sub">실시 ${held}회${p.tgContract ? ` / 예정 ${p.tgContract.plannedCount}회` : ''}</span></div><div class="bd np tbl-wrap">${visitsHtml}</div></div>
        <div class="panel"><div class="hd"><h3>작업일자 · 기술지도 달력</h3><div class="right" id="pcal-nav"></div></div><div class="bd" id="pcal"></div></div>` : ''}
        ${p.status !== 'NOT_TARGET' && p.status !== 'MONITORING' ? `<div class="panel"><div class="hd"><h3>제출 자료</h3></div><div class="bd np">${docsHtml}</div></div>` : ''}
        <div class="panel"><div class="hd"><h3>자동 안내 발송 내역</h3><span class="sub">E-메일 · SMS</span></div><div class="bd np" style="max-height:520px;overflow:auto">${notiHtml}</div></div>
      </div>
      <div>
        <div class="panel"><div class="hd"><h3>대상여부 판정</h3></div><div class="bd">${judgeHtml}</div></div>
        ${cycleHtml ? `<div class="panel"><div class="hd"><h3>기술지도 누락 방지</h3></div><div class="bd">${cycleHtml}</div></div>` : ''}
        <div class="panel"><div class="hd"><h3>처리 이력</h3></div><div class="bd" style="max-height:640px;overflow:auto">${hist}</div></div>
      </div>
    </div>`, p.name.length > 14 ? `${p.name.slice(0, 14)}…` : p.name);
  bindShell();
  renderActions(p);
  if ($('#pcal')) projectCalendar(p);
}

// 상세 화면 액션 폼
function renderActions(p) {
  const A = new Set(p.actions);
  const m = S.meta;
  const cards = [];
  const card = (title, who, inner, id) => `<div class="action-card" ${id ? `id="${id}"` : ''}><h4>${title}<span class="who">${esc(who)}</span></h4>${inner}</div>`;

  if (A.has('upload_docs')) {
    cards.push(card('📤 기술지도 관련자료 Upload 및 제출', '협력업체', `
      ${p.supplementNote ? `<div class="alert warn">기관 보완요청: ${esc(p.supplementNote)}</div>` : ''}
      <div class="form">${m.settings.docTypes.map((d) => `<label class="${d.required ? 'req' : ''}">${esc(d.label)}</label><input type="file" name="file_${d.key}" multiple>`).join('')}</div>
      <div class="btn-row" style="margin-top:10px"><button class="btn" data-act="upload_docs">파일 Upload</button><button class="btn primary" data-act="submit_docs">기술지도기관에 제출</button>
      <span class="small muted">파일을 먼저 Upload 한 후 '제출'을 누르세요. 필수자료가 모두 있어야 제출됩니다.</span></div>`));
  }
  if (A.has('submit_tg_contract')) {
    cards.push(card('📑 자료 검토 및 기술지도 계약서 제출', '기술지도기관', `
      <div class="form">
        <label class="req">기술지도 계약서</label><input type="file" name="file_TG_CONTRACT">
        <label>계약일자</label><input type="date" name="contractDate" value="${today()}">
        <label>기술지도 계약번호</label><input name="tgContractNo">
        <label>기술지도 기간</label><div class="btn-row"><input type="date" name="guidanceStart" value="${esc(p.guidancePeriod?.start || '')}"> ~ <input type="date" name="guidanceEnd" value="${esc(p.guidancePeriod?.end || '')}"></div>
        <label>예정 지도횟수</label><input type="number" name="plannedCount" placeholder="미입력 시 기간/${m.settings.cycleDays}일로 자동 계산">
        <label>노동부 제출일</label><input type="date" name="moelSubmittedDate">
      </div>
      <div class="btn-row" style="margin-top:10px"><button class="btn primary" data-act="submit_tg_contract">계약서 제출 → 기술지도 개시</button></div>
      <hr style="border:0;border-top:1px solid var(--line);margin:14px 0">
      <div class="form"><label>보완 요청 사항</label><textarea name="note_sup" placeholder="자료 보완이 필요한 경우 입력"></textarea></div>
      <div class="btn-row" style="margin-top:8px"><button class="btn danger" data-act="request_supplement" data-note="note_sup">협력업체에 보완 요청</button></div>`));
  }
  if (A.has('safety_check') && !p.safetyCheck) {
    cards.push(card('✅ 기술지도 계약서 · 노동부 제출 여부 확인', '안전보건환경부서', `
      <div class="form"><label>확인 의견</label><input name="note_sc" placeholder="(선택)"></div>
      <div class="btn-row" style="margin-top:8px"><button class="btn primary" data-act="safety_check" data-note="note_sc">확인 완료</button><span class="small muted">결재 절차 없이 확인 기록만 남깁니다.</span></div>`));
  }
  if (A.has('set_work_days')) {
    cards.push(card('🗓 월별 작업일자 지정', '협력업체', `
      <div class="cal-hd"><button class="btn sm" id="wd-prev">◀</button><b id="wd-month"></b><button class="btn sm" id="wd-next">▶</button><span class="small muted">달력에서 작업일을 클릭하여 선택/해제 후 저장 (기술지도 기간 내)</span></div>
      <div id="wd-cal"></div>
      <div class="btn-row" style="margin-top:10px"><button class="btn primary" id="wd-save">이 달 작업일자 저장 · 기관에 안내</button><span class="small" id="wd-cnt"></span></div>`, 'wd-card'));
  }
  if (A.has('schedule_visit')) {
    const used = new Set((p.visits || []).filter((v) => v.status !== 'CANCELED').map((v) => v.plannedDate));
    const cands = (p.workDays || []).filter((d) => d >= today() && !used.has(d));
    const due = p.cycle?.nextDue;
    cards.push(card('📍 기술지도 일자 선택', '기술지도기관', cands.length ? `
      <div class="form">
        <label class="req">지도일자(작업일 중)</label><select name="date">${cands.map((d) => `<option value="${d}">${d} (${'일월화수목금토'[new Date(d + 'T00:00:00Z').getUTCDay()]})${due && d > due ? ' ⚠ 주기기한 초과' : ''}</option>`).join('')}</select>
        <label>방문 시간</label><input type="time" name="time" value="10:00">
        <label>지도요원</label><input name="inspector" value="${esc(S.user.name)}">
      </div>
      ${due ? `<div class="field-note">※ 다음 지도 기한: ${esc(due)} — 기한 내 일자를 선택하세요.</div>` : ''}
      <div class="btn-row" style="margin-top:10px"><button class="btn primary" data-act="schedule_visit">지도일 지정 · 자동 안내 발송</button></div>`
      : '<div class="muted small">선택 가능한 작업일자가 없습니다. 협력업체의 작업일자 지정을 기다리는 중입니다.</div>'));
  }
  for (const v of p.visits || []) {
    if (v.status === 'SCHEDULED' && A.has('cancel_visit') && v.plannedDate > today()) {
      cards.push(card(`📍 ${v.round}회차 기술지도 예정 (${v.plannedDate} ${esc(v.time || '')})`, '기술지도기관', `
        <div class="small muted">현장 기술지도 방문 후(지도일 이후) 결과를 제출할 수 있습니다.</div>
        <div class="form" style="margin-top:8px"><label>취소 사유</label><input name="note_cv_${v.id}"></div>
        <div class="btn-row" style="margin-top:8px"><button class="btn danger" data-act="cancel_visit" data-visit="${v.id}" data-note="note_cv_${v.id}" data-confirm="이 일정을 취소하시겠습니까?">일정 취소</button></div>`));
    }
    if (v.status === 'SCHEDULED' && A.has('submit_result') && v.plannedDate <= today()) {
      cards.push(card(`📝 ${v.round}회차 기술지도 결과 제출 (${v.plannedDate})`, '기술지도기관', `
        <div class="form">
          <label class="req">실제 지도일자</label><input type="date" name="actualDate" value="${v.plannedDate}">
          <label class="req">기술지도 내용</label><textarea name="summary" placeholder="현장 기술지도 방문 후 지도내용 작성"></textarea>
          <label>보완사항 발생</label><label style="color:inherit"><input type="checkbox" name="hasFindings" class="hf"> 미비점·개선요구 사항 있음</label>
          <label>미비점 및 개선요구</label><textarea name="findings" placeholder="보완사항 발생 시 입력"></textarea>
          <label>개선 기한</label><input type="date" name="improveDue" value="${addDays(v.plannedDate, 7)}">
          <label>노동부 결과 제출</label><label style="color:inherit"><input type="checkbox" name="moelReported"> 고용노동부에 기술지도 결과 제출함</label>
          <label>결과보고서</label><input type="file" name="file_TG_RESULT" multiple>
        </div>
        <div class="btn-row" style="margin-top:10px"><button class="btn primary" data-act="submit_result" data-visit="${v.id}">결과 제출</button><button class="btn danger" data-act="cancel_visit" data-visit="${v.id}" data-confirm="이 일정을 취소하시겠습니까?">일정 취소</button></div>`));
    }
    if (v.status === 'IMPROVEMENT_REQUESTED' && A.has('submit_improvement')) {
      cards.push(card(`🔧 ${v.round}회차 미비점 보완 및 개선결과 보고`, '협력업체', `
        <div class="alert warn">보완요구: ${esc(v.findings)} (기한 ${esc(v.improveDue)})${(v.reviews || []).filter((r) => !r.ok).slice(-1).map((r) => `<br>재보완 사유: ${esc(r.note)}`).join('')}</div>
        <div class="form"><label class="req">개선 조치 내용</label><textarea name="note_imp_${v.id}"></textarea><label>개선 사진/자료</label><input type="file" name="file_IMPROVEMENT" multiple></div>
        <div class="btn-row" style="margin-top:10px"><button class="btn primary" data-act="submit_improvement" data-visit="${v.id}" data-note="note_imp_${v.id}">개선결과 보고</button></div>`));
    }
    if (v.status === 'IMPROVEMENT_SUBMITTED' && A.has('review_improvement')) {
      const last = (v.improvements || []).slice(-1)[0];
      cards.push(card(`🔍 ${v.round}회차 보완사항 검토`, '기술지도기관', `
        <div class="small">보완요구: ${esc(v.findings)}<br>개선보고: ${esc(last?.note || '')} <span class="chip-files">${(last?.files || []).map((fid) => p.files.find((f) => f.id === fid)).filter(Boolean).map(fileLink).join('')}</span></div>
        <div class="form" style="margin-top:8px"><label>검토 의견</label><textarea name="note_rv_${v.id}" placeholder="재보완 요청 시 필수"></textarea></div>
        <div class="btn-row" style="margin-top:8px"><button class="btn success" data-act="review_improvement" data-visit="${v.id}" data-decision="accept" data-note="note_rv_${v.id}">확인 완료</button><button class="btn danger" data-act="review_improvement" data-visit="${v.id}" data-decision="reject" data-note="note_rv_${v.id}">재보완 요청</button></div>`));
    }
  }
  if (A.has('ext_purchase') && p.extension?.step === 'PURCHASE') {
    cards.push(card(`📄 ${p.extension.round}차 연장 — 계약서 갱신`, '구매부서', `
      <div class="small muted" style="margin-bottom:8px">연장 사유: ${esc(p.extension.reason)}</div>
      <div class="form">
        <label class="req">갱신 계약서</label><input type="file" name="file_EXT_PURCHASE_CONTRACT" multiple>
        ${p.type === 'UNIT_PRICE' ? '<label>계약서 구분</label><select name="contractKind"><option>가계약서</option><option>본계약서</option><option>가계약서+본계약서</option></select>' : ''}
        <label class="req">변경 종료일</label><input type="date" name="newEndDate" value="${addDays(p.endDate, 30)}">
        <label>변경 계약금액</label><input name="newAmount" placeholder="변경 시 입력(원)">
      </div>
      <div class="btn-row" style="margin-top:10px"><button class="btn primary" data-act="ext_purchase">갱신 계약서 제출</button></div>`));
  }
  if (A.has('ext_contractor') && p.extension?.step === 'CONTRACTOR') {
    cards.push(card(`📂 ${p.extension.round}차 연장 — 관련서류 제출`, '협력업체', `
      <div class="form">
        <label class="req">갱신 계약서 / 납품연기원</label><input type="file" name="file_EXT_DOCS" multiple>
        <label class="req">산재가입증명서 갱신</label><input type="file" name="file_EXT_INSURANCE" multiple>
        <label>비고</label><input name="note_ec">
      </div>
      <div class="btn-row" style="margin-top:10px"><button class="btn primary" data-act="ext_contractor" data-note="note_ec">관련서류 제출</button></div>`));
  }
  if (A.has('ext_agency') && p.extension?.step === 'AGENCY') {
    cards.push(card(`🖋 ${p.extension.round}차 연장 — 기술지도 추가계약서 제출`, '기술지도기관', `
      <div class="form">
        <label class="req">추가계약서</label><input type="file" name="file_EXT_TG_CONTRACT">
        <label class="req">연장 기술지도 종료일</label><input type="date" name="guidanceEnd" value="${esc(p.endDate)}">
      </div>
      <div class="btn-row" style="margin-top:10px"><button class="btn primary" data-act="ext_agency">추가계약서 제출 → 연장 완료</button></div>`));
  }
  if (p.status === 'EXTENSION' && p.extension) {
    const st = ['PURCHASE', 'CONTRACTOR', 'AGENCY'];
    const idx = st.indexOf(p.extension.step);
    cards.unshift(`<div class="alert info"><div><b>${p.extension.round}차 기간 연장 진행 중</b> — 사유: ${esc(p.extension.reason)}<br>
      ${['① 계약서 갱신(구매부서)', '② 관련서류 제출(협력업체)', '③ 추가계약서 제출(기술지도기관)'].map((s, i) => i < idx ? `✅ ${s}` : i === idx ? `<b>▶ ${s}</b>` : `⬜ ${s}`).join(' &nbsp; ')}</div></div>`);
  }
  if (A.has('close') || A.has('start_extension')) {
    const open = (p.visits || []).filter((v) => ['SCHEDULED', 'IMPROVEMENT_REQUESTED', 'IMPROVEMENT_SUBMITTED'].includes(v.status));
    cards.push(card('🏁 종결 / 기간 연장', '협력업체 관리부서', `
      <div class="grid g2">
        <div>${A.has('close') ? `<div class="form"><label>현장공사 완료일</label><input type="date" name="completionDate" value="${today()}"><label>비고</label><input name="note_close"></div>
          ${open.length ? `<label class="small" style="display:block;margin-top:6px"><input type="checkbox" name="force" value="true"> 미완료 기술지도 ${open.length}건 포함 종결(예정 일정은 취소)</label>` : ''}
          <div class="btn-row" style="margin-top:8px"><button class="btn success" data-act="close" data-note="note_close" data-confirm="현장공사 완료로 기술지도를 종결하시겠습니까?">현장공사 완료 → 종결</button></div>` : ''}</div>
        <div>${A.has('start_extension') ? `<div class="form"><label class="req">연장 사유</label><textarea name="note_ext" placeholder="예: 공사기간 연장(설계변경) / 단가계약 계약기간 연장"></textarea></div>
          <div class="btn-row" style="margin-top:8px"><button class="btn" data-act="start_extension" data-note="note_ext">기간 연장 절차 시작</button></div>` : ''}</div>
      </div>`));
  }
  if (A.has('assign') && !['CLOSED'].includes(p.status)) {
    const dept = m.departments.filter((d) => d.kind === 'PARTNER_MGMT');
    cards.push(card('👥 담당부서 · 기술지도기관 지정', '협력업체 관리부서 / 안전보건환경부서', `
      <div class="form">
        <label>담당부서</label><select name="deptId"><option value="">-</option>${dept.map((d) => `<option value="${d.id}" ${d.id === p.deptId ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select>
        <label>공사 담당자</label><select name="managerUserId"><option value="">-</option>${m.users.filter((u) => u.role === 'PARTNER_MGMT').map((u) => `<option value="${u.id}" ${u.id === p.managerUserId ? 'selected' : ''}>${esc(u.name)} (${esc(orgName(u))})</option>`).join('')}</select>
        <label>기술지도기관</label><select name="agencyId" ${['ACTIVE', 'EXTENSION'].includes(p.status) ? 'disabled' : ''}><option value="">미지정</option>${m.agencies.map((a) => `<option value="${a.id}" ${a.id === p.agencyId ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select>
      </div>
      <div class="btn-row" style="margin-top:8px"><button class="btn" data-act="assign">저장</button></div>`));
  }
  if (A.has('update_info')) {
    cards.push(`<details class="action-card"><summary><b>✏️ 공사 정보 수정</b> <span class="small muted">구매부서 / 협력업체 관리부서 — 수정 시 대상여부 재판정</span></summary>
      <div class="form" style="margin-top:10px">
        <label>공사 구분</label><select name="type"><option value="GENERAL" ${p.type === 'GENERAL' ? 'selected' : ''}>일반공사</option><option value="UNIT_PRICE" ${p.type === 'UNIT_PRICE' ? 'selected' : ''}>단가계약</option></select>
        <label>공사계약명</label><input name="name" value="${esc(p.name)}">
        <label>계약번호</label><input name="contractNo" value="${esc(p.contractNo)}">
        <label>업체명</label><input name="companyName" value="${esc(p.companyName)}">
        <label>계약기간</label><div class="btn-row"><input type="date" name="startDate" value="${p.startDate}"> ~ <input type="date" name="endDate" value="${p.endDate}"></div>
        <label>계약금액(원)</label><input name="amount" value="${p.amount}">
        <label>작업장소</label><input name="workPlace" value="${esc(p.workPlace || '')}">
        <label>수정 사유</label><input name="note_upd">
      </div>
      <div class="btn-row" style="margin-top:10px"><button class="btn primary" data-act="update_info" data-note="note_upd">수정 및 재판정</button></div></details>`);
  }
  const box = $('#actions');
  if (!cards.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="panel"><div class="hd"><h3>업무 처리</h3><span class="sub">${esc(roleLabel(S.user.role))} 권한으로 가능한 작업</span></div><div class="bd">${cards.join('')}</div></div>`;

  $$('[data-act]', box).forEach((btn) => btn.addEventListener('click', async () => {
    const act = btn.dataset.act;
    if (btn.dataset.confirm && !(await askConfirm(btn.dataset.confirm))) return;
    const scope = btn.closest('.action-card');
    const fd = new FormData();
    $$('input, select, textarea', scope).forEach((el) => {
      if (!el.name) return;
      if (el.type === 'file') { for (const f of el.files) fd.append(el.name, f); return; }
      if (el.type === 'checkbox') { if (el.checked) fd.append(el.name, el.value === 'on' ? 'true' : el.value); return; }
      if (el.name.startsWith('note_')) return;
      fd.append(el.name, el.value);
    });
    if (btn.dataset.note) { const n = $(`[name="${btn.dataset.note}"]`, scope); if (n) fd.append('note', n.value); }
    if (btn.dataset.visit) fd.append('visitId', btn.dataset.visit);
    if (btn.dataset.decision) fd.append('decision', btn.dataset.decision);
    if (act === 'submit_docs') { for (const k of [...fd.keys()]) if (k.startsWith('file_')) fd.delete(k); }
    btn.disabled = true;
    try {
      await api('POST', `/projects/${p.id}/actions/${act}`, fd);
      toast(`${m.actions[act]?.label || act} 완료`, 'ok');
      await loadMeta();
      render();
    } catch (e) { toast(e.message, 'err'); btn.disabled = false; }
  }));

  if ($('#wd-card')) workDayPicker(p);
}

function monthGrid(ym, cellFn) {
  const [y, mo] = ym.split('-').map(Number);
  const first = new Date(Date.UTC(y, mo - 1, 1));
  const startDow = first.getUTCDay();
  const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  let html = '일월화수목금토'.split('').map((d) => `<div class="dh">${d}</div>`).join('');
  for (let i = 0; i < startDow; i++) html += '<div class="d out"></div>';
  for (let d = 1; d <= days; d++) {
    const ds = `${ym}-${String(d).padStart(2, '0')}`;
    const dow = (startDow + d - 1) % 7;
    html += cellFn(ds, d, dow === 0 ? 'sun' : dow === 6 ? 'sat' : '');
  }
  const tail = (7 - ((startDow + days) % 7)) % 7;
  for (let i = 0; i < tail; i++) html += '<div class="d out"></div>';
  return html;
}
const shiftMonth = (ym, n) => { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7); };

function workDayPicker(p) {
  let ym = today() < p.guidancePeriod.start ? p.guidancePeriod.start.slice(0, 7) : today().slice(0, 7);
  if (ym > p.guidancePeriod.end.slice(0, 7)) ym = p.guidancePeriod.end.slice(0, 7);
  let sel = new Set();
  const draw = () => {
    sel = new Set((p.workDays || []).filter((d) => d.startsWith(ym)));
    paint();
  };
  const paint = () => {
    $('#wd-month').textContent = ym;
    const visitDays = new Set((p.visits || []).filter((v) => v.status !== 'CANCELED').map((v) => v.plannedDate));
    $('#wd-cal').innerHTML = `<div class="cal pick">${monthGrid(ym, (ds, d, cls) => {
      const dis = ds < p.guidancePeriod.start || ds > p.guidancePeriod.end;
      return `<div class="d ${cls} ${dis ? 'dis' : ''} ${sel.has(ds) ? 'sel' : ''} ${ds === today() ? 'today' : ''}" data-d="${ds}"><div class="n">${d}</div>${sel.has(ds) ? '<span class="ev work">작업일</span>' : ''}${visitDays.has(ds) ? '<span class="ev visit">기술지도</span>' : ''}</div>`;
    })}</div>`;
    $('#wd-cnt').textContent = `선택 ${sel.size}일`;
    $$('#wd-cal .d[data-d]:not(.dis)').forEach((c) => c.addEventListener('click', () => { const d = c.dataset.d; sel.has(d) ? sel.delete(d) : sel.add(d); paint(); }));
  };
  $('#wd-prev').addEventListener('click', () => { ym = shiftMonth(ym, -1); draw(); });
  $('#wd-next').addEventListener('click', () => { ym = shiftMonth(ym, 1); draw(); });
  $('#wd-save').addEventListener('click', async () => {
    const fd = new FormData();
    fd.append('month', ym);
    fd.append('days', [...sel].sort().join(','));
    try {
      await api('POST', `/projects/${p.id}/actions/set_work_days`, fd);
      toast(`${ym} 작업일자 ${sel.size}일 저장 — 기술지도기관에 안내했습니다.`, 'ok');
      render();
    } catch (e) { toast(e.message, 'err'); }
  });
  draw();
}

function projectCalendar(p) {
  let ym = today().slice(0, 7);
  if (p.guidancePeriod && today() < p.guidancePeriod.start) ym = p.guidancePeriod.start.slice(0, 7);
  if (p.guidancePeriod && today() > p.guidancePeriod.end) ym = p.guidancePeriod.end.slice(0, 7);
  const draw = () => {
    const vis = {};
    for (const v of p.visits || []) if (v.status !== 'CANCELED') vis[v.actualDate || v.plannedDate] = v;
    const work = new Set(p.workDays || []);
    $('#pcal-nav').innerHTML = `<button class="btn sm" id="pc-prev">◀</button><b style="min-width:70px;text-align:center">${ym}</b><button class="btn sm" id="pc-next">▶</button>`;
    $('#pcal').innerHTML = `<div class="cal">${monthGrid(ym, (ds, d, cls) => {
      const v = vis[ds];
      const vcls = v ? (v.status === 'SCHEDULED' ? 'visit' : v.status.startsWith('IMPROVEMENT') ? 'imp' : 'done') : '';
      const inP = p.guidancePeriod && ds >= p.guidancePeriod.start && ds <= p.guidancePeriod.end;
      return `<div class="d ${cls} ${ds === today() ? 'today' : ''}" style="${inP ? '' : 'background:var(--subtle)'}"><div class="n">${d}</div>${work.has(ds) ? '<span class="ev work">작업일</span>' : ''}${v ? `<span class="ev ${vcls}">${v.round}회 ${S.meta.visitStatus[v.status]}</span>` : ''}${p.cycle && ds === p.cycle.nextDue ? '<span class="ev imp">지도기한</span>' : ''}</div>`;
    })}</div><div class="legend"><span><i style="background:var(--gray-bg)"></i>작업일(협력업체)</span><span><i style="background:var(--blue-bg)"></i>지도 예정</span><span><i style="background:var(--green-bg)"></i>지도 완료</span><span><i style="background:var(--orange-bg)"></i>보완 진행 / 지도기한</span><span>음영 = 기술지도 기간 외</span></div>`;
    $('#pc-prev').addEventListener('click', () => { ym = shiftMonth(ym, -1); draw(); });
    $('#pc-next').addEventListener('click', () => { ym = shiftMonth(ym, 1); draw(); });
  };
  draw();
}

// ───────────── 단가계약 정산·누계 ─────────────
async function pageSettlements() {
  const year = new URLSearchParams(S.route.split('?')[1] || '').get('year') || today().slice(0, 4);
  const d = await api('GET', `/settlements?year=${year}`);
  const can = ['PURCHASE', 'PARTNER_MGMT', 'ADMIN'].includes(S.user.role);
  const th = d.threshold;
  const rows = d.rows;
  const total = rows.length, target = rows.filter((r) => r.judgment?.target).length, warn = rows.filter((r) => !r.judgment?.target && r.judgment?.warning).length;
  $('#app').innerHTML = shell('단가계약 월별 정산실적 · 누계 관리', `
    <div class="kpis">
      <div class="kpi"><div class="k">단가계약</div><div class="v">${total}</div></div>
      <div class="kpi"><div class="k">기술지도 대상</div><div class="v" style="color:var(--red)">${target}</div></div>
      <div class="kpi"><div class="k">누계 주의(${Math.round(S.meta.settings.warnRatio * 100)}%↑ / 초과예상)</div><div class="v" style="color:var(--orange)">${warn}</div></div>
      <div class="kpi"><div class="k">비대상</div><div class="v">${total - target - warn}</div></div>
    </div>
    ${can ? `<div class="panel"><div class="hd"><h3>월별 정산실적 Upload</h3><span class="sub">단가업체별 월별 정산실적(엑셀/CSV) → 단가계약별 연간 누계 자동 계산 · 1억원 이상 시 기술지도 대상 자동 전환/안내</span></div>
      <div class="bd"><div class="btn-row"><input type="file" id="st-file" accept=".xlsx,.csv"><button class="btn primary" id="st-up">Upload 및 누계 반영</button><button class="btn" id="st-tpl">⬇ 양식 다운로드</button></div>
      <div class="field-note">※ 추후 구매시스템/SAP 월별 정산금액 자동 연동 예정. 양식: 계약번호 | 공사계약명 | 업체명 | 정산월(YYYY-MM) | 정산금액 (가로형: 연도 | 1월~12월 도 지원)</div>
      <div id="st-result"></div></div></div>` : ''}
    <div class="panel"><div class="hd"><h3>${year}년 단가계약별 누계 정산금액</h3><div class="right"><select id="yr">${[0, 1, 2].map((i) => +today().slice(0, 4) - i).map((y) => `<option ${String(y) === year ? 'selected' : ''}>${y}</option>`).join('')}</select></div></div>
      <div class="bd np tbl-wrap"><table class="tbl small"><thead><tr><th>공사계약명</th><th>업체명</th><th class="num">계약금액</th>${Array.from({ length: 12 }, (_, i) => `<th class="num">${i + 1}월</th>`).join('')}<th class="num">누계</th><th style="min-width:120px">기준 대비</th><th>판정/상태</th></tr></thead><tbody>
      ${rows.map((r) => {
        const ratio = r.cumulative / th;
        return `<tr class="click" onclick="go('#/projects/${r.id}')\"><td><b>${esc(r.name)}</b><div class="muted">${esc(r.contractNo)}</div></td><td>${esc(r.companyName)}</td><td class="num">${eok(r.amount)}</td>
        ${Array.from({ length: 12 }, (_, i) => { const v = r.months[String(i + 1).padStart(2, '0')]; return `<td class="num">${v != null ? Math.round(v / 1e4).toLocaleString('ko-KR') : '<span class="muted">-</span>'}</td>`; }).join('')}
        <td class="num"><b>${Math.round(r.cumulative / 1e4).toLocaleString('ko-KR')}</b></td>
        <td><div class="bar ${ratio >= 1 ? 'over' : r.judgment?.warning ? 'warn' : ''}"><i style="width:${Math.min(100, ratio * 100)}%"></i></div>${(ratio * 100).toFixed(1)}%${r.judgment?.forecast && !r.judgment?.target ? `<div class="muted">예상 ${eok(r.judgment.forecast)}</div>` : ''}</td>
        <td>${judgeBadge(r)}<div style="margin-top:3px">${statusBadge(r)}</div></td></tr>`;
      }).join('') || `<tr><td colspan="18" class="empty">단가계약 공사가 없습니다.</td></tr>`}
      </tbody></table></div><div class="bd small muted">금액 단위: 만원 (계약금액은 억원) · 행을 클릭하면 공사 상세로 이동</div></div>`);
  bindShell();
  $('#yr').addEventListener('change', (e) => { go(`#/settlements?year=${e.target.value}`); });
  if (can) {
    $('#st-tpl').addEventListener('click', () => download('/settlements/template', '정산실적_양식.xlsx'));
    $('#st-up').addEventListener('click', async () => {
      const f = $('#st-file').files[0];
      if (!f) return toast('파일을 선택해 주세요.', 'err');
      const fd = new FormData(); fd.append('file', f);
      try {
        const r = await api('POST', '/settlements/upload', fd);
        toast(`정산실적 반영: 신규 ${r.inserted}건, 갱신 ${r.updated}건`, 'ok');
        await pageSettlements();
        $('#st-result').innerHTML = `<div class="alert ${r.changed.length ? 'danger' : 'ok'}" style="margin-top:10px"><div>처리 ${r.total}행 — 신규 ${r.inserted} · 갱신 ${r.updated} · 미매칭 ${r.unmatched.length} · 오류 ${r.invalid.length}
          ${r.changed.map((c) => `<br>🔔 <b>${esc(c.name)}</b>: ${esc(c.from)} → <b>${esc(c.to)}</b> (자동 안내 발송)`).join('')}
          ${r.unmatched.length ? `<br><span class="small">미매칭: ${esc(r.unmatched.slice(0, 5).map((u) => u.contractNo || u.name || u.company).join(', '))}${r.unmatched.length > 5 ? ' 외' : ''}</span>` : ''}</div></div>`;
      } catch (e) { toast(e.message, 'err'); }
    });
  }
}

// ───────────── 전체 일정 ─────────────
async function pageCalendar() {
  const list = await api('GET', '/projects');
  let ym = today().slice(0, 7);
  $('#app').innerHTML = shell('기술지도 일정', `<div class="panel"><div class="hd"><h3>월간 기술지도 일정</h3><div class="right"><label class="small"><input type="checkbox" id="show-work"> 작업일 표시</label><button class="btn sm" id="c-prev">◀</button><b id="c-ym" style="min-width:70px;text-align:center"></b><button class="btn sm" id="c-next">▶</button></div></div><div class="bd" id="c-body"></div></div>
    <div class="panel"><div class="hd"><h3>기술지도 진행 공사 주기 현황</h3></div><div class="bd np tbl-wrap" id="c-cycle"></div></div>`);
  bindShell();
  const draw = () => {
    $('#c-ym').textContent = ym;
    const showWork = $('#show-work').checked;
    const ev = {};
    for (const p of list) {
      for (const v of p.visits || []) if (v.status !== 'CANCELED') (ev[v.actualDate || v.plannedDate] = ev[v.actualDate || v.plannedDate] || []).push({ p, v });
      if (showWork) for (const w of p.workDays || []) (ev[w] = ev[w] || []).push({ p, work: true });
    }
    $('#c-body').innerHTML = `<div class="cal">${monthGrid(ym, (ds, d, cls) => `<div class="d ${cls} ${ds === today() ? 'today' : ''}"><div class="n">${d}</div>${(ev[ds] || []).map((e) => e.work ? `<a class="ev work" href="#/projects/${e.p.id}" title="${esc(e.p.name)}">작업 · ${esc(e.p.companyName)}</a>` : `<a class="ev ${e.v.status === 'SCHEDULED' ? 'visit' : e.v.status.startsWith('IMPROVEMENT') ? 'imp' : 'done'}" href="#/projects/${e.p.id}" title="${esc(e.p.name)} ${e.v.round}회차">${esc(e.v.time || '')} ${esc(e.p.name)}</a>`).join('')}</div>`)}</div>`;
  };
  const active = list.filter((p) => p.cycle);
  $('#c-cycle').innerHTML = active.length ? `<table class="tbl"><thead><tr><th>공사</th><th>기관</th><th>기술지도 기간</th><th>직전 지도</th><th>다음 기한</th><th>예정일</th><th>상태</th></tr></thead><tbody>${active.map((p) => { const c = p.cycle; return `<tr class="click" onclick="go('#/projects/${p.id}')\"><td>${esc(p.name)}</td><td class="small">${esc(p.agencyName)}</td><td class="small nowrap">${esc(p.guidancePeriod.start)} ~ ${esc(p.guidancePeriod.end)}</td><td>${esc(c.last || '-')}</td><td><b>${esc(c.nextDue)}</b></td><td>${esc(c.upcoming || '미지정')}</td><td>${c.level === 'overdue' ? badge('주기 초과', 'red') : c.level === 'expired' ? badge('기간 경과', 'red') : c.level === 'warn' ? badge('일정 필요', 'orange') : badge('정상', 'green')}</td></tr>`; }).join('')}</tbody></table>` : '<div class="empty">진행 중인 기술지도가 없습니다.</div>';
  $('#c-prev').addEventListener('click', () => { ym = shiftMonth(ym, -1); draw(); });
  $('#c-next').addEventListener('click', () => { ym = shiftMonth(ym, 1); draw(); });
  $('#show-work').addEventListener('change', draw);
  draw();
}

// ───────────── 알림 ─────────────
async function pageNotifications() {
  const canAll = ['ADMIN', 'SAFETY', 'PARTNER_MGMT', 'PURCHASE'].includes(S.user.role);
  const scope = new URLSearchParams(S.route.split('?')[1] || '').get('scope') === 'all' && canAll ? 'all' : 'mine';
  const list = await api('GET', `/notifications?scope=${scope}`);
  const ch = new URLSearchParams(S.route.split('?')[1] || '').get('ch') || 'EMAIL';
  const rows = list.filter((n) => n.channel === ch);
  $('#app').innerHTML = shell('알림 (E-메일 · SMS)', `
    <div class="alert info">ℹ️ <div>DEMO 버전에서는 실제 메일/SMS를 발송하지 않고 아래와 같이 기록합니다. 사내 메일서버·SMS 게이트웨이 연동 시 동일 내용이 실제 발송됩니다.</div></div>
    <div class="tabs">
      <a class="${scope === 'mine' && ch === 'EMAIL' ? 'active' : ''}" href="#/notifications?scope=mine&ch=EMAIL">내 메일함</a>
      <a class="${scope === 'mine' && ch === 'SMS' ? 'active' : ''}" href="#/notifications?scope=mine&ch=SMS">내 SMS</a>
      ${canAll ? `<a class="${scope === 'all' && ch === 'EMAIL' ? 'active' : ''}" href="#/notifications?scope=all&ch=EMAIL">전체 발송함(메일)</a><a class="${scope === 'all' && ch === 'SMS' ? 'active' : ''}" href="#/notifications?scope=all&ch=SMS">전체 발송함(SMS)</a>` : ''}
      <span style="margin-left:auto"></span>${scope === 'mine' ? '<button class="btn sm" id="read-all">모두 읽음</button>' : ''}
    </div>
    <div class="panel"><div class="bd np">${rows.length ? `<ul class="list">${rows.map((n) => `<li class="${!n.read && scope === 'mine' ? 'unread' : ''}"><span>${n.channel === 'EMAIL' ? '✉️' : '📱'}</span><div class="grow">
      <div>${!n.read && scope === 'mine' ? badge('NEW', 'red') + ' ' : ''}${esc(n.subject)}</div>
      <div class="small muted">${esc(n.date)} · 수신: ${esc(n.toName)} (${esc(roleLabel(n.toRole))}) ${esc(n.toAddr)} · <a href="#/projects/${n.projectId}">${esc(n.projectName)}</a></div>
      <details data-id="${n.id}"><summary class="small">내용 보기</summary><div class="mail-body">${esc(n.body)}</div></details></div></li>`).join('')}</ul>` : '<div class="empty">알림이 없습니다.</div>'}</div></div>`);
  bindShell();
  $$('details[data-id]').forEach((d) => d.addEventListener('toggle', () => { if (d.open) api('POST', '/notifications/read', { ids: [d.dataset.id] }).catch(() => {}); }));
  if ($('#read-all')) $('#read-all').addEventListener('click', async () => { await api('POST', '/notifications/read', { all: true }); render(); });
}

// ───────────── 업무 흐름 ─────────────
function pageFlow() {
  const lanes = ['협력업체 관리부서', '안전보건환경부서', '기술지도기관', '협력업체', '구매부서'];
  const B = (t, cls = '') => `<div class="box ${cls}">${t}</div>`;
  const rows = [
    ['① 공사계약 체결', ['', '', '', '', B('공사 계약서 Upload<br><span class="small muted">(신규 공사 등록)</span>')]],
    ['② 대상여부 판단', [B('🤖 자동 판정<br><span class="small">일반: 1개월↑ &amp; 1억↑<br>단가: 계약 1억↑ 또는 연간 누계 1억↑</span>', 'sys') + B('대상 아님 → 종료 / 단가는 누계관리', 'end'), '', '', '', B('월별 정산실적 Upload<br><span class="small muted">(단가계약 누계)</span>')]],
    ['③ 대상 안내', [B('🤖 자동 E-메일·SMS<br><span class="small">관리부서·업체·기관·안전</span>', 'sys'), B('수신', 'out'), B('수신: 계약서 제출 안내', 'out'), B('수신: 관련자료 제출 안내', 'out'), '']],
    ['④ 자료 제출·계약', ['', B('계약서·노동부 제출 확인<br><span class="small muted">(결재 없음, 확인 기록)</span>'), B('자료 검토', 'dec') + B('기술지도 계약서 Upload'), B('관련자료 Upload 제출<br><span class="small muted">계약서·산재가입증명서·사업자등록증</span>') + B('보완 요청 시 재제출', 'out'), '']],
    ['⑤ 기술지도 진행', [B('진행 모니터링'), B('진행 모니터링'), B('작업일 중 지도일 선택') + B('🤖 지정일 자동 안내', 'sys') + B('현장지도 → 결과 제출') + B('보완사항 검토', 'dec'), B('월별 작업일자 지정') + B('미비점 보완·개선결과 보고'), '']],
    ['   누락 방지', [B('🤖 15일 주기 점검 · 결과 미제출 · 만료 D-15 자동 안내', 'sys'), '', '', '', '']],
    ['⑥ 기간 연장', [B('연장 요청'), '', B('③ 추가계약서 제출'), B('② 갱신계약서/납품연기원, 산재가입증명서 갱신'), B('① 계약서 갱신<br><span class="small muted">단가: 가계약서/본계약서</span>')]],
    ['⑦ 종결', [B('현장공사 완료 → 종결'), '', B('비용계산서 발급', 'out'), '', '']],
    ['비용 정산', [B('기술지도 비용정산<br><span class="small">(시스템 범위 외 — 별도 시스템)</span>', 'out'), '', '', '', '']],
  ];
  const st = S.meta.status;
  $('#app').innerHTML = shell('업무 흐름(Flow)', `
    <div class="panel"><div class="hd"><h3>재해예방 기술지도 업무 Flow — 시스템 구현 기준</h3><span class="sub">유첨 Flow-chart(rev1) + 시스템 구현 순서도 반영</span></div><div class="bd tbl-wrap">
      <div class="flow"><div class="lane-h">구분</div>${lanes.map((l) => `<div class="lane-h">${l}</div>`).join('')}
      ${rows.map(([stage, cells]) => `<div class="stage">${stage}</div>${cells.map((c) => `<div class="cell">${c}</div>`).join('')}`).join('')}</div>
      <div class="legend"><span><i style="background:var(--green-bg);border:1px solid var(--green)"></i>시스템 자동 처리</span><span><i style="background:var(--orange-bg);border:1px solid var(--orange)"></i>판단(검토)</span><span><i style="border:1px dashed #999"></i>수신/범위 외</span></div>
    </div></div>
    <div class="grid g2">
      <div class="panel"><div class="hd"><h3>상태(State) 정의</h3></div><div class="bd np"><table class="tbl"><thead><tr><th>상태</th><th>의미 / 다음 담당</th></tr></thead><tbody>
        <tr><td>${badge(st.NOT_TARGET.label, 'gray')}</td><td>일반공사 판정 결과 비대상 (정보 수정 시 재판정)</td></tr>
        <tr><td>${badge(st.MONITORING.label, 'blue')}</td><td>단가계약 1억 미만 — 정산실적 누계 관리, 누계 1억 도달 시 자동 대상 전환</td></tr>
        <tr><td>${badge(st.DOCS_REQUESTED.label, 'orange')}</td><td>대상 판정·자동 안내 완료 → <b>협력업체</b> 관련자료 제출</td></tr>
        <tr><td>${badge(st.DOCS_SUBMITTED.label, 'orange')}</td><td><b>기술지도기관</b> 자료 검토 → 계약서 제출(또는 보완요청)</td></tr>
        <tr><td>${badge(st.ACTIVE.label, 'green')}</td><td>작업일 지정(협력업체) → 지도일 선택·결과 제출(기관) → 보완(협력업체/기관)</td></tr>
        <tr><td>${badge(st.EXTENSION.label, 'purple')}</td><td>구매 계약서 갱신 → 협력업체 서류 → 기관 추가계약서 (지도는 계속 진행)</td></tr>
        <tr><td>${badge(st.CLOSED.label, 'gray')}</td><td>현장공사 완료로 협력업체 관리부서가 종결</td></tr>
      </tbody></table></div></div>
      <div class="panel"><div class="hd"><h3>자동 안내(E-메일·SMS) 시점</h3></div><div class="bd np"><table class="tbl small"><thead><tr><th>시점</th><th>수신</th></tr></thead><tbody>
        <tr><td>기술지도 대상 판정 (등록/누계 도달)</td><td>관리부서 · 협력업체 · 기관 · 안전보건</td></tr>
        <tr><td>관련자료 제출 / 보완요청</td><td>기관 · 관리부서 / 협력업체</td></tr>
        <tr><td>기술지도 계약서 제출(개시)</td><td>4개 주체</td></tr>
        <tr><td>작업일자 지정</td><td>기관</td></tr>
        <tr><td>기술지도 지정일 / 일정 취소</td><td>4개 주체</td></tr>
        <tr><td>결과 제출(보완요구 포함) / 개선결과·검토</td><td>4개 주체 / 기관·관리부서·협력업체</td></tr>
        <tr><td>🤖 만료 D-${S.meta.settings.endNoticeDays} (종결 또는 연장서류 제출 안내)</td><td>4개 주체</td></tr>
        <tr><td>🤖 ${S.meta.settings.cycleDays}일 주기 임박/초과, 결과 미제출, 기간 경과</td><td>기관 · 협력업체 · 관리부서 (· 안전보건)</td></tr>
        <tr><td>🤖 단가계약 누계 ${Math.round(S.meta.settings.warnRatio * 100)}% 이상 또는 초과 예상</td><td>관리부서 · 안전보건</td></tr>
        <tr><td>연장 각 단계 / 종결</td><td>다음 단계 담당 / 4개 주체</td></tr>
      </tbody></table></div></div>
    </div>`);
  bindShell();
}

// ───────────── DEMO 운영 · 기준정보 ─────────────
async function pageAdmin() {
  if (S.user.role !== 'ADMIN') { go('#/dashboard'); return; }
  await loadMeta();
  const m = S.meta, s = m.settings;
  $('#app').innerHTML = shell('DEMO 운영 · 기준정보', `
    <div class="grid g2">
      <div class="panel"><div class="hd"><h3>⏱ 데모 기준일 (시간 경과 시뮬레이션)</h3></div><div class="bd">
        <div class="small muted" style="margin-bottom:10px">기준일을 앞당겨 만료 D-15 안내, 15일 주기 초과 경보 등 자동 처리를 시험할 수 있습니다. 변경 시 일일 점검이 즉시 실행됩니다.</div>
        <div class="btn-row"><input type="date" id="demo-date" value="${esc(m.today)}"><button class="btn primary" id="set-date">기준일 적용</button><button class="btn" id="real-date">실제 날짜로</button></div>
        <div class="btn-row" style="margin-top:10px"><button class="btn" data-adv="1">+1일</button><button class="btn" data-adv="7">+7일</button><button class="btn" data-adv="15">+15일</button><button class="btn" data-adv="30">+30일</button><button class="btn" id="run-check">일일 점검 지금 실행</button></div>
        <div id="adv-result" class="small" style="margin-top:10px"></div>
      </div></div>
      <div class="panel"><div class="hd"><h3>판정 · 안내 기준</h3></div><div class="bd">
        <div class="form">
          <label>기준 금액(원)</label><input id="s-amountThreshold" value="${s.amountThreshold}">
          <label>기준 공사기간(개월)</label><input id="s-periodMonths" type="number" value="${s.periodMonths}">
          <label>단가 누계 주의비율</label><input id="s-warnRatio" type="number" step="0.05" value="${s.warnRatio}">
          <label>만료 사전안내(일 전)</label><input id="s-endNoticeDays" type="number" value="${s.endNoticeDays}">
          <label>기술지도 주기(일)</label><input id="s-cycleDays" type="number" value="${s.cycleDays}">
          <label>주기 사전안내(경과일)</label><input id="s-cycleRemindDays" type="number" value="${s.cycleRemindDays}">
          <label>기본 기술지도기관</label><select id="s-defaultAgencyId"><option value="">없음</option>${m.agencies.map((a) => `<option value="${a.id}" ${a.id === s.defaultAgencyId ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select>
          <label>발송 채널</label><div><label><input type="checkbox" id="s-notifyEmail" ${s.notifyEmail ? 'checked' : ''}> E-메일</label> &nbsp; <label><input type="checkbox" id="s-notifySms" ${s.notifySms ? 'checked' : ''}> SMS</label></div>
        </div>
        <div class="btn-row" style="margin-top:10px"><button class="btn primary" id="save-settings">저장</button></div>
      </div></div>
    </div>
    <div class="panel"><div class="hd"><h3>사용자</h3><span class="sub">DEMO 로그인 대상 · 알림 수신자</span></div><div class="bd np tbl-wrap"><table class="tbl small"><thead><tr><th>이름</th><th>역할</th><th>소속</th><th>직책</th><th>E-메일</th><th>휴대폰</th></tr></thead><tbody>
      ${m.users.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(roleLabel(u.role))}</td><td>${esc(orgName(u))}</td><td>${esc(u.title || '')}</td><td>${esc(u.email || '')}</td><td>${esc(u.phone || '')}</td></tr>`).join('')}
    </tbody></table></div>
    <div class="bd" style="border-top:1px solid var(--line-2)"><div class="filters">
      <input id="nu-name" placeholder="이름"><select id="nu-role">${Object.entries(m.roles).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select>
      <select id="nu-org"></select><input id="nu-title" placeholder="직책"><input id="nu-email" placeholder="E-메일"><input id="nu-phone" placeholder="휴대폰"><button class="btn" id="nu-add">사용자 추가</button></div></div></div>
    <div class="grid g2">
      <div class="panel"><div class="hd"><h3>협력업체</h3></div><div class="bd np"><table class="tbl small"><tbody>${m.companies.map((c) => `<tr><td>${esc(c.name)}</td><td>${esc(c.bizNo || '')}</td><td>${esc(c.phone || '')}</td></tr>`).join('')}</tbody></table></div>
        <div class="bd"><div class="filters"><input id="nc-name" placeholder="업체명"><input id="nc-biz" placeholder="사업자번호"><button class="btn" id="nc-add">추가</button></div></div></div>
      <div class="panel"><div class="hd"><h3>기술지도기관</h3></div><div class="bd np"><table class="tbl small"><tbody>${m.agencies.map((a) => `<tr><td>${esc(a.name)}</td><td>${esc(a.phone || '')}</td><td>${esc(a.email || '')}</td></tr>`).join('')}</tbody></table></div>
        <div class="bd"><div class="filters"><input id="na-name" placeholder="기관명"><input id="na-phone" placeholder="연락처"><button class="btn" id="na-add">추가</button></div></div></div>
    </div>
    <div class="panel"><div class="hd"><h3>DEMO 데이터 초기화</h3></div><div class="bd"><div class="btn-row"><button class="btn danger" id="reset">시연 데이터로 초기화</button><span class="small muted">모든 공사·자료·알림을 삭제하고 시연용 샘플 데이터를 다시 생성합니다.</span></div></div></div>`);
  bindShell();
  const after = async (r) => {
    await loadMeta();
    $('#adv-result').innerHTML = r && r.dailyCheck ? `기준일 ${esc(r.dailyCheck.date)} 점검 결과: ${r.dailyCheck.results.length ? r.dailyCheck.results.map(esc).join(' / ') : '신규 발송 없음'}` : '';
    const html = $('#adv-result').innerHTML;
    await pageAdmin();
    $('#adv-result').innerHTML = html;
  };
  $('#set-date').addEventListener('click', async () => { try { await after(await api('PUT', '/admin/settings', { demoToday: $('#demo-date').value })); toast('기준일 적용', 'ok'); } catch (e) { toast(e.message, 'err'); } });
  $('#real-date').addEventListener('click', async () => { await after(await api('PUT', '/admin/settings', { demoToday: null })); toast('실제 날짜로 복귀', 'ok'); });
  $$('[data-adv]').forEach((b) => b.addEventListener('click', async () => { const r = await api('POST', '/admin/advance', { days: Number(b.dataset.adv) }); await after({ dailyCheck: r.dailyCheck }); toast(`기준일 → ${r.today}`, 'ok'); }));
  $('#run-check').addEventListener('click', async () => { const r = await api('POST', '/admin/daily-check'); await after({ dailyCheck: r }); });
  $('#save-settings').addEventListener('click', async () => {
    const body = {};
    for (const k of ['amountThreshold', 'periodMonths', 'warnRatio', 'endNoticeDays', 'cycleDays', 'cycleRemindDays']) body[k] = Number($(`#s-${k}`).value.replace(/,/g, ''));
    body.defaultAgencyId = $('#s-defaultAgencyId').value;
    body.notifyEmail = $('#s-notifyEmail').checked; body.notifySms = $('#s-notifySms').checked;
    try { await api('PUT', '/admin/settings', body); toast('저장되었습니다. (비대상 공사 재판정 완료)', 'ok'); await after(); } catch (e) { toast(e.message, 'err'); }
  });
  const orgOpts = () => {
    const r = $('#nu-role').value;
    const list = r === 'CONTRACTOR' ? m.companies : r === 'AGENCY' ? m.agencies : r === 'ADMIN' ? [] : m.departments.filter((d) => d.kind === (r === 'PARTNER_MGMT' ? 'PARTNER_MGMT' : r));
    $('#nu-org').innerHTML = list.map((o) => `<option value="${o.id}">${esc(o.name)}</option>`).join('') || '<option value="">-</option>';
  };
  $('#nu-role').addEventListener('change', orgOpts); orgOpts();
  const add = (kind, body) => api('POST', `/admin/${kind}`, body).then(() => { toast('추가되었습니다.', 'ok'); after(); }).catch((e) => toast(e.message, 'err'));
  $('#nu-add').addEventListener('click', () => add('users', { name: $('#nu-name').value, role: $('#nu-role').value, orgId: $('#nu-org').value || null, title: $('#nu-title').value, email: $('#nu-email').value, phone: $('#nu-phone').value }));
  $('#nc-add').addEventListener('click', () => add('companies', { name: $('#nc-name').value, bizNo: $('#nc-biz').value }));
  $('#na-add').addEventListener('click', () => add('agencies', { name: $('#na-name').value, phone: $('#na-phone').value }));
  $('#reset').addEventListener('click', async () => {
    if (!(await askConfirm('모든 공사·자료·알림을 지우고 시연용 샘플 데이터로 다시 만듭니다.', '초기화'))) return;
    await api('POST', '/admin/reset'); await loadMeta(); toast('초기화 완료', 'ok'); go('#/dashboard');
  });
}

// ───────────── 시작 ─────────────
// 다른 사용자가 데이터를 바꾸면(공유 저장소) 입력 중이 아닐 때 화면을 새로 그린다
window.__TG_onRemoteChange = async () => {
  if (!S.meta || $('#modal-root').children.length) return;
  const a = document.activeElement;
  if (a && /INPUT|TEXTAREA|SELECT/.test(a.tagName) && a.id !== 'user-switch') return;
  try { await loadMeta(); if (S.user) S.user = S.meta.users.find((u) => u.id === S.user.id) || S.user; render(); } catch { /* 무시 */ }
};

(async function init() {
  try {
    if (window.__TG_LOCAL) await window.__TG_LOCAL.ready;
    await loadMeta();
    const uid = LS.get('tg_user');
    S.user = S.meta.users.find((u) => u.id === uid) || null;
    render();
  } catch (e) {
    $('#app').innerHTML = `<div class="login"><div class="alert danger">서버에 연결할 수 없습니다: ${esc(e.message)}</div></div>`;
  }
})();
