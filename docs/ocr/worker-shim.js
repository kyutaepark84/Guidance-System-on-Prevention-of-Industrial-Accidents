'use strict';
// OCR 작업자(Web Worker) 앞단: 웹페이지 배포에서는 학습데이터를 .gz로 둘 수 없어 base64 텍스트(.gz.txt)로 배포한다.
// tesseract 작업자가 *.traineddata.gz 를 요청하면 *.traineddata.gz.txt 를 받아 바이너리로 풀어 돌려준 뒤,
// 원래 작업자 스크립트(worker.min.js)를 실행한다.
var originalFetch = self.fetch.bind(self);
self.fetch = function (input, init) {
  var url = String(input && input.url ? input.url : input);
  if (!/\.traineddata\.gz$/.test(url)) return originalFetch(input, init);
  return originalFetch(url + '.txt', init).then(function (res) {
    if (!res.ok) return res;
    return res.text().then(function (text) {
      var bin = atob(text.trim());
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new Response(bytes, { status: 200 });
    });
  });
};
importScripts(new URL('worker.min.js', self.location.href).href);
