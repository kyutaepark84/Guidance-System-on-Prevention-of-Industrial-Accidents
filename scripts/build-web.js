'use strict';
// 웹페이지(브라우저 단독 실행) 빌드: node scripts/build-web.js → web/dist/tg-demo.html
// server/ 의 판정·업무흐름 코드를 그대로 묶고, 저장소·PDF·API 처리부만 web/ 의 브라우저 구현으로 바꾼다.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const MODULES = {
  dates: 'server/dates.js',
  rules: 'server/rules.js',
  notify: 'server/notify.js',
  workflow: 'server/workflow.js',
  extract: 'server/extract.js',
  settlement: 'server/settlement.js',
  seed: 'server/seed.js',
  db: 'web/db.js',
  pdftext: 'web/pdftext.js',
  docmap: 'web/docmap.js',
  router: 'web/router.js',
  platform: 'web/platform.js',
};

const LIBS = [
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
];

const defs = Object.entries(MODULES).map(([name, file]) => {
  const src = read(file).replace(/<\/script/gi, '<\\/script');
  return `__def(${JSON.stringify(name)}, function (module, exports, require) {\n${src}\n});`;
}).join('\n');

const bundle = `(function () {
'use strict';
var __mods = {}, __cache = {};
function __def(n, f) { __mods[n] = f; }
function __lib(name, key) {
  // CDN 라이브러리는 사용할 때 확인한다(불러오지 못해도 나머지 기능은 동작)
  return new Proxy({}, { get: function (t, k) {
    var L = window[key];
    if (!L) throw new Error(name + ' 기능을 불러오지 못했습니다. 네트워크 상태를 확인하거나 정보를 직접 입력해 주세요.');
    return L[k];
  } });
}
var EXT = {
  path: { extname: function (n) { var m = /\\.[^./\\\\]*$/.exec(n || ''); return m ? m[0] : ''; } },
  jszip: __lib('압축(DOCX/HWPX) 분석', 'JSZip'),
  exceljs: __lib('엑셀', 'ExcelJS'),
};
function __req(n) {
  var name = n.replace(/^\\.\\//, '');
  if (EXT[name]) return EXT[name];
  if (__cache[name]) return __cache[name].exports;
  if (!__mods[name]) throw new Error('module not found: ' + n);
  var m = { exports: {} };
  __cache[name] = m;
  __mods[name](m, m.exports, __req);
  return m.exports;
}
var Buffer = { from: function (s) { return new TextEncoder().encode(String(s)); } };
${defs}
__req('platform');
})();`;

const css = read('public/style.css');
const app = read('public/app.js').replace(/<\/script/gi, '<\\/script');

const html = `<title>재해예방 기술지도 관리시스템</title>
<style>
${css}
</style>
<div id="app"><div class="login"><div class="alert info">불러오는 중…</div></div></div>
<div id="modal-root"></div>
<div id="toast-root"></div>
${LIBS.map((u) => `<script src="${u}"></script>`).join('\n')}
<script>window.__TG_LOCAL_BUILD = true;</script>
<script>
${bundle}
</script>
<script>
${app}
</script>
`;

const out = path.join(ROOT, 'web', 'dist', 'tg-demo.html');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log(`웹페이지 빌드 완료: ${path.relative(ROOT, out)} (${(html.length / 1024).toFixed(0)} KB)`);
