'use strict';
// 브라우저용 저장소: 메모리 상태 + 저장 신호(platform.js가 공유 저장소/브라우저 저장소에 반영)
let db = null;

function emptyDb() {
  return { meta: { version: 1 }, settings: {}, departments: [], companies: [], agencies: [], users: [], projects: [], settlements: [], files: [], notifications: [] };
}
function get() { if (!db) db = emptyDb(); return db; }
function set(next) { db = next; }
function load() { return { db: get(), fresh: false }; }
function save() { if (typeof window !== 'undefined' && window.__TG_persist) window.__TG_persist(); }
function reset() { db = emptyDb(); return db; }
function id(prefix) {
  const a = new Uint8Array(5);
  crypto.getRandomValues(a);
  return `${prefix}_${[...a].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}
// buf: { assetId, size } (업로드된 파일) 또는 Uint8Array(시연용 가짜 파일)
function storeFile(buf, meta) {
  const rec = {
    id: id('f'),
    assetId: (buf && buf.assetId) || null,
    originalName: meta.originalName,
    size: buf ? (buf.size != null ? buf.size : buf.length || 0) : 0,
    mime: meta.mime || 'application/octet-stream',
    projectId: meta.projectId || null,
    category: meta.category || '기타',
    ref: meta.ref || null,
    uploadedBy: meta.uploadedBy || null,
    uploadedAt: new Date().toISOString(),
  };
  get().files.push(rec);
  return rec;
}
module.exports = { load, save, reset, get, set, id, storeFile, filePath: () => null, DATA_DIR: '' };
