'use strict';
// DEMO용 경량 저장소: 메모리 객체 + JSON 파일(data/db.json) 영속화.
// 단일 프로세스 데모 용도이며, 사내 시스템 구축 시 RDB로 교체한다(스키마는 docs/설계서 참고).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.TG_DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

let db = null;

function emptyDb() {
  return {
    meta: { version: 1, createdAt: new Date().toISOString() },
    settings: {},
    departments: [],
    companies: [],
    agencies: [],
    users: [],
    projects: [],
    settlements: [],
    files: [],
    notifications: [],
  };
}

function ensureDirs() {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

function load() {
  ensureDirs();
  if (fs.existsSync(DB_FILE)) {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    for (const [k, v] of Object.entries(emptyDb())) if (!(k in db)) db[k] = v;
    return { db, fresh: false };
  }
  db = emptyDb();
  return { db, fresh: true };
}

function save() {
  ensureDirs();
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
  fs.renameSync(tmp, DB_FILE);
}

function reset() {
  ensureDirs();
  for (const f of fs.readdirSync(UPLOAD_DIR)) fs.rmSync(path.join(UPLOAD_DIR, f), { force: true });
  db = emptyDb();
  return db;
}

function get() {
  if (!db) load();
  return db;
}

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(5).toString('hex')}`;
}

function storeFile(buf, meta) {
  ensureDirs();
  const fid = id('f');
  const ext = path.extname(meta.originalName || '').toLowerCase().replace(/[^a-z0-9.]/g, '');
  const storedName = fid + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, storedName), buf);
  const rec = {
    id: fid,
    storedName,
    originalName: meta.originalName,
    size: buf.length,
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

function filePath(rec) {
  return path.join(UPLOAD_DIR, rec.storedName);
}

module.exports = { load, save, reset, get, id, storeFile, filePath, DATA_DIR };
