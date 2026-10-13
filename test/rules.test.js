'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { judge, periodOk } = require('../server/rules');
const { parseKoreanAmount, parseContractText } = require('../server/extract');
const dates = require('../server/dates');

const T = '2026-10-13';
const gen = (o) => ({ id: 'p', type: 'GENERAL', startDate: '2026-01-01', endDate: '2026-03-31', amount: 100000000, ...o });
const unit = (o) => ({ id: 'u', type: 'UNIT_PRICE', startDate: '2026-01-01', endDate: '2026-12-31', amount: 50000000, ...o });
const st = (pid, list) => list.map(([month, amount]) => ({ projectId: pid, month, amount }));

test('공사기간 1개월 이상 판단(시작일 포함)', () => {
  assert.equal(periodOk('2026-01-01', '2026-01-31', 1), true);
  assert.equal(periodOk('2026-01-01', '2026-01-30', 1), false);
  assert.equal(periodOk('2026-01-31', '2026-02-27', 1), true); // 1/31 + 1개월 = 2/28 → -1일 = 2/27
  assert.equal(periodOk('2026-01-31', '2026-02-26', 1), false);
});

test('일반공사: 기간 AND 금액 동시 충족 시에만 대상', () => {
  assert.equal(judge(gen(), [], undefined, T).target, true);
  assert.equal(judge(gen({ amount: 99999999 }), [], undefined, T).target, false);
  assert.equal(judge(gen({ endDate: '2026-01-20' }), [], undefined, T).target, false);
});

test('단가계약: 계약금액 1억 이상이면 대상', () => {
  const j = judge(unit({ amount: 100000000 }), [], undefined, T);
  assert.equal(j.target, true);
  assert.equal(j.basis, 'UNIT_CONTRACT_AMOUNT');
});

test('단가계약: 1억 미만이라도 연간 누계 1억 이상이면 대상, 초과월 기록', () => {
  const s = st('u', [['2026-01', 40000000], ['2026-02', 40000000], ['2026-03', 25000000]]);
  const j = judge(unit(), s, undefined, T);
  assert.equal(j.target, true);
  assert.equal(j.basis, 'UNIT_CUMULATIVE');
  assert.equal(j.triggerMonth, '2026-03');
});

test('단가계약: 연도가 다르면 누계 분리', () => {
  const s = st('u', [['2025-12', 60000000], ['2026-01', 60000000]]);
  assert.equal(judge(unit({ startDate: '2025-12-01' }), s, undefined, T).target, false);
});

test('단가계약: 누계 80% 이상이면 주의', () => {
  const s = st('u', [['2026-01', 85000000]]);
  const j = judge(unit({ endDate: '2026-01-31' }), s, undefined, T);
  assert.equal(j.target, false);
  assert.equal(j.warning, true);
});

test('단가계약: 연말 예상 누계 초과 시 주의', () => {
  const s = st('u', [['2026-01', 10000000], ['2026-02', 10000000], ['2026-03', 10000000]]);
  const j = judge(unit(), s, undefined, '2026-04-10');
  assert.equal(j.forecast, 120000000);
  assert.equal(j.warning, true);
});

test('기준값 설정 변경 반영', () => {
  assert.equal(judge(gen({ amount: 60000000 }), [], { amountThreshold: 50000000 }, T).target, true);
});

test('한글 금액 파싱', () => {
  assert.equal(parseKoreanAmount('일금 일억이천삼백사십오만육천칠백팔십구원정'), 123456789);
  assert.equal(parseKoreanAmount('금 1억 2,000만원'), 120000000);
  assert.equal(parseKoreanAmount('₩153,000,000'), 153000000);
  assert.equal(parseKoreanAmount('오천만원'), 50000000);
  assert.equal(parseKoreanAmount('십억원'), 1000000000);
});

test('계약서 텍스트 필드 추출', () => {
  const r = parseContractText([
    '공 사 도 급 계 약 서',
    '계약번호 : C-2026-0520',
    '1. 공 사 명 : 2공장 CW 배관 교체공사',
    '3. 계약기간 : 2026년 11월 1일 ~ 2027년 1월 31일',
    '4. 계약금액 : 일금 일억오천삼백만원정 (₩153,000,000, 부가가치세 포함)',
    '발주자와 수급인은 상호 대등한 입장에서 계약을 체결한다.',
    '수 급 인 (을) : 상호 : 동해기전(주)   대표이사 : 홍길동 (인)',
  ].join('\n'));
  assert.deepEqual(r.fields, {
    name: '2공장 CW 배관 교체공사', contractNo: 'C-2026-0520', companyName: '동해기전(주)',
    startDate: '2026-11-01', endDate: '2027-01-31', amount: 153000000, type: 'GENERAL',
  });
  assert.deepEqual(r.missing, []);
});

test('단가계약 키워드 및 표 형식(콜론 없음) 추출', () => {
  const r = parseContractText('연간 단가계약서\n계약명 [단가계약] 3공장 배관정비\n업체명 태화이엔지(주)\n계약기간 2026.11.01 ~ 2026.12.31\n계약금액 85,000,000원');
  assert.equal(r.fields.type, 'UNIT_PRICE');
  assert.equal(r.fields.companyName, '태화이엔지(주)');
  assert.equal(r.fields.amount, 85000000);
  assert.equal(r.fields.endDate, '2026-12-31');
});

test('날짜 유틸', () => {
  assert.equal(dates.addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(dates.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(dates.diffDays('2026-10-01', '2026-10-16'), 15);
});
