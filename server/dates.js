'use strict';
// 날짜는 모두 'YYYY-MM-DD' 문자열(현지 날짜)로 다룬다. 시간대 영향을 피하기 위해 UTC 기준으로 계산한다.

function parse(s) {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
}

function fmt(d) {
  return d.toISOString().slice(0, 10);
}

function addDays(s, n) {
  const d = parse(s);
  d.setUTCDate(d.getUTCDate() + n);
  return fmt(d);
}

// 월 단위 가산. 말일 보정(1/31 + 1개월 = 2/28 또는 2/29)
function addMonths(s, n) {
  const d = parse(s);
  const day = d.getUTCDate();
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(day, last));
  return fmt(t);
}

function diffDays(a, b) {
  // b - a (일)
  return Math.round((parse(b) - parse(a)) / 86400000);
}

function isValid(s) {
  const d = parse(s);
  return !!d && fmt(d) === s;
}

function todayReal() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

module.exports = { parse, fmt, addDays, addMonths, diffDays, isValid, todayReal };
