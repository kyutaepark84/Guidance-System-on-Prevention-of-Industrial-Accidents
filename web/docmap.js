'use strict';
// 메모리 상태 ↔ 공유 저장소 문서 변환 (브라우저와 Node 양쪽에서 사용)
//  meta/state       : 설정·기준정보·사용자
//  projects/<id>    : 공사 1건(이력 포함)
//  notis/<id>       : 공사별 발송 기록 {list}
//  files/<id>       : 공사별 첨부 메타데이터 {list}
//  settle/<id>      : 공사별 월별 정산실적 {list}
const COLLECTIONS = ['meta', 'projects', 'notis', 'files', 'settle'];
const NOTI_KEEP = 250; // 문서 크기 제한(256KiB) 대비 공사별 최근 발송 기록만 보관

function group(list, keyFn) {
  const m = new Map();
  for (const x of list) {
    const k = keyFn(x) || 'none';
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

function toDocs(st) {
  const out = new Map();
  out.set('meta/state', { settings: st.settings, departments: st.departments, companies: st.companies, agencies: st.agencies, users: st.users, meta: st.meta });
  for (const p of st.projects) out.set(`projects/${p.id}`, p);
  for (const [k, list] of group(st.notifications, (n) => n.projectId)) out.set(`notis/${k}`, { list: list.slice(-NOTI_KEEP) });
  for (const [k, list] of group(st.files, (f) => f.projectId)) out.set(`files/${k}`, { list });
  for (const [k, list] of group(st.settlements, (s) => s.projectId)) out.set(`settle/${k}`, { list });
  return out;
}

function fromDocs(docs) {
  const meta = docs.get('meta/state') || {};
  const st = {
    meta: meta.meta || { version: 1 }, settings: meta.settings || {}, departments: meta.departments || [], companies: meta.companies || [],
    agencies: meta.agencies || [], users: meta.users || [], projects: [], settlements: [], files: [], notifications: [],
  };
  const clone = (x) => JSON.parse(JSON.stringify(x));
  for (const [path, body] of docs) {
    const [col] = path.split('/');
    if (col === 'projects') st.projects.push(clone(body));
    else if (col === 'notis') st.notifications.push(...clone(body.list || []));
    else if (col === 'files') st.files.push(...clone(body.list || []));
    else if (col === 'settle') st.settlements.push(...clone(body.list || []));
  }
  st.projects.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  st.notifications.sort((a, b) => (a.at || '').localeCompare(b.at || ''));
  return st;
}

module.exports = { toDocs, fromDocs, COLLECTIONS };
