'use strict';
// 브라우저 실행 환경 연결부
//  - claude.ai 웹페이지(Artifact): 공유 저장소(db)에 데이터를 두어 접속한 모든 사람이 같은 데이터를 보고,
//    첨부파일은 첨부 보관함(assets)에, 내려받기는 downloads 기능으로 처리한다.
//  - 그 밖의 환경(로컬 파일로 열기 등): 이 브라우저(localStorage)에만 저장한다.
const store = require('./db');
const router = require('./router');
const docmap = require('./docmap');
const wf = require('./workflow');

let DB = null;
let ASSETS = null;
let DL = null;
const saved = new Map(); // 문서 경로 → 마지막으로 저장/수신한 내용(정렬된 JSON)
const docs = new Map(); // 문서 경로 → 내용
const P = { mode: 'memory', readOnly: false, uploadFile };
router.setPlatform(P);

// 키 순서와 무관한 비교용 직렬화 (저장소가 키 순서를 바꿔도 불필요한 재기록이 생기지 않게)
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}

const say = (msg, kind = 'err') => { if (typeof window.toast === 'function') window.toast(msg, kind); };

function writeError(e) {
  const code = e && e.code;
  if (code === 'invalid_argument') {
    P.readOnly = true;
    say('저장 권한이 없어 읽기 전용으로 전환합니다. 공유 설정에서 참여자(Contributor) 이상 권한이 필요합니다.');
  } else if (code === 'quota_exceeded') {
    say('저장 공간이 가득 찼습니다. 관리자 화면에서 시연 데이터를 초기화해 주세요.');
  } else {
    say(`저장 중 오류가 발생했습니다(${code || '알 수 없음'}). 잠시 후 다시 시도해 주세요.`);
  }
}

let writing = Promise.resolve();
let timer = null;
function flush() {
  timer = null;
  const st = store.get();
  if (P.mode === 'local') {
    try { localStorage.setItem('tg_state', JSON.stringify(st)); } catch { /* 저장 불가 환경: 메모리로만 유지 */ }
    return;
  }
  if (P.mode !== 'shared' || P.readOnly) return;
  const next = docmap.toDocs(st);
  const ops = [];
  for (const [path, body] of next) {
    const s = stable(body);
    if (saved.get(path) === s) continue;
    saved.set(path, s);
    const copy = JSON.parse(JSON.stringify(body));
    docs.set(path, copy);
    ops.push(() => DB.doc(path).set(copy));
  }
  for (const path of [...saved.keys()]) {
    if (next.has(path)) continue;
    saved.delete(path);
    docs.delete(path);
    ops.push(() => DB.doc(path).delete());
  }
  if (!ops.length) return;
  writing = writing.then(async () => {
    for (const op of ops) {
      try { await op(); } catch (e) {
        if (e && e.code === 'unavailable') {
          await new Promise((r) => setTimeout(r, 400 + Math.random() * 600));
          try { await op(); continue; } catch (e2) { writeError(e2); }
        } else writeError(e);
        if (P.readOnly) break;
      }
    }
  });
}
window.__TG_persist = () => { if (!timer) timer = setTimeout(flush, 30); };

// 다른 사람이 바꾼 내용 반영
let remoteTimer = null;
function onRemote() {
  clearTimeout(remoteTimer);
  remoteTimer = setTimeout(() => {
    store.set(docmap.fromDocs(docs));
    if (typeof window.__TG_onRemoteChange === 'function') window.__TG_onRemoteChange();
  }, 250);
}

function subscribe() {
  for (const col of docmap.COLLECTIONS) {
    DB.collection(col).onSnapshot((qs) => {
      let changed = false;
      for (const ch of qs.docChanges()) {
        const path = `${col}/${ch.doc.id}`;
        if (ch.type === 'removed') {
          if (docs.has(path)) { docs.delete(path); saved.delete(path); changed = true; }
          continue;
        }
        const body = ch.doc.data();
        const s = stable(body);
        if (saved.get(path) === s) continue;
        saved.set(path, s);
        docs.set(path, JSON.parse(JSON.stringify(body)));
        changed = true;
      }
      if (changed) onRemote();
    }, () => { /* 실시간 갱신이 끊겨도 화면은 계속 사용 가능 */ });
  }
}

async function loadShared() {
  for (const col of docmap.COLLECTIONS) {
    let snap;
    try { snap = await DB.collection(col).limit(1000).get(); } catch (e) {
      if (e && e.code === 'unavailable') { await new Promise((r) => setTimeout(r, 600)); snap = await DB.collection(col).limit(1000).get(); } else throw e;
    }
    for (const d of snap.docs) {
      const path = `${col}/${d.id}`;
      const body = d.data();
      docs.set(path, JSON.parse(JSON.stringify(body)));
      saved.set(path, stable(body));
    }
  }
  store.set(docmap.fromDocs(docs));
}

function loadLocal() {
  P.mode = 'local';
  let st = null;
  try { st = JSON.parse(localStorage.getItem('tg_state') || 'null'); } catch { st = null; }
  if (st && Array.isArray(st.users) && st.users.length) store.set(st);
  else require('./seed').seed();
}

async function start() {
  const claude = window.claude;
  if (claude && typeof claude.use === 'function') {
    try { DB = await claude.use('db'); } catch { DB = null; }
  }
  if (DB) {
    try {
      const [assets, dl, user] = await Promise.all(['assets', 'downloads', 'user'].map((n) => claude.use(n).catch(() => null)));
      ASSETS = assets; DL = dl;
      if (user) {
        try { if ((await user.can('data.write')) === false) P.readOnly = true; } catch { /* 모름: 쓰기 시도 결과로 판단 */ }
      }
      await loadShared();
      P.mode = 'shared';
      subscribe();
    } catch {
      DB = null;
      loadLocal();
    }
  } else {
    loadLocal();
  }
  const st = store.get();
  if (st.users.length && !P.readOnly) {
    const last = st.meta.lastDailyCheck;
    if (!last || last.date !== wf.today()) wf.dailyCheck();
  }
}

function toBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(new Error('파일을 읽지 못했습니다.'));
    r.readAsDataURL(file);
  });
}

// 첨부파일: 형식과 관계없이 보관할 수 있도록 JSON(이름·형식·base64)으로 감싸 보관함에 올린다
async function uploadFile(file) {
  if (!ASSETS) return { assetId: null, size: file.size };
  const wrapped = new Blob([JSON.stringify({ name: file.name, type: file.type, b64: await toBase64(file) })], { type: 'application/json' });
  try {
    const up = await ASSETS.upload(wrapped, { type: 'application/json' });
    return { assetId: up.id, size: file.size };
  } catch (e) {
    const code = e && e.code;
    if (code === 'quota_or_state') throw new Error('첨부 보관 공간이 부족합니다. 더 작은 파일을 올려 주세요.');
    if (code === 'rate_limited') throw new Error('업로드가 너무 잦습니다. 잠시 후 다시 시도해 주세요.');
    throw new Error(`파일을 보관하지 못했습니다(${code || '오류'}).`);
  }
}

async function saveFile(data, filename) {
  if (!DL) {
    if (P.mode === 'shared') throw new Error('이 화면에서는 파일 내려받기를 사용할 수 없습니다.');
    // 일반 웹사이트(GitHub Pages 등): 브라우저 기본 내려받기
    const a = document.createElement('a');
    a.href = URL.createObjectURL(data instanceof Blob ? data : new Blob([data]));
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(a.href); }, 3000);
    return;
  }
  try {
    await DL.save({ filename, data: data instanceof Blob ? data : new Blob([data]) });
  } catch (e) {
    const code = e && e.code;
    if (code === 'declined') return;
    if (code === 'rejected_extension' || code === 'extension_not_enabled') throw new Error(`이 형식의 파일은 웹페이지에서 내려받을 수 없습니다: ${filename}`);
    if (code === 'rate_limited') throw new Error('이미 내려받기 확인 창이 열려 있습니다.');
    throw new Error(`내려받기에 실패했습니다(${code || '오류'}).`);
  }
}

async function download(url, user) {
  const res = await router.handle('GET', url, undefined, user);
  const f = res.__file;
  if (f.record) {
    if (!f.record.assetId) throw new Error(P.mode === 'shared' && ASSETS ? '시연용 샘플 기록이라 파일 내용이 없습니다. 직접 올린 파일은 내려받을 수 있습니다.' : '이 화면에서는 첨부파일 내용이 보관되지 않습니다(목록만 기록).');
    const r = await fetch(`/_blob/${f.record.assetId}`);
    if (!r.ok) throw new Error('보관된 파일을 찾을 수 없습니다.');
    const w = await r.json();
    const bin = atob(w.b64 || '');
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return saveFile(bytes, f.record.originalName);
  }
  return saveFile(f.data, f.filename);
}

async function api(method, url, body, user) {
  try {
    return await router.handle(method, url, body, user);
  } catch (e) {
    throw new Error((e && e.message) || '오류가 발생했습니다.');
  }
}

window.__TG_LOCAL = { ready: start(), api, download, platform: P };
