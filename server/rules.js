'use strict';
// 재해예방 기술지도 대상여부 판정 규칙 (산업안전보건법 제73조 및 단가계약 운영방안 반영)
//  - 일반 공사   : 공사기간 1개월 이상 AND 공사금액 1억원 이상 → 대상
//  - 단가계약 공사: 계약금액 1억원 이상 → 대상
//                  계약금액 1억원 미만이라도 연간 누적 정산금액 1억원 이상 → 대상
// 기준값은 설정(settings)에서 바꿀 수 있다.
const dates = require('./dates');

const DEFAULT_RULES = {
  amountThreshold: 100000000, // 1억원
  periodMonths: 1, // 1개월
  warnRatio: 0.8, // 단가계약 누계 주의 비율(80%)
};

function periodOk(start, end, months) {
  if (!dates.isValid(start) || !dates.isValid(end)) return false;
  // 시작일 포함 기준: 1/1 ~ 1/31 은 1개월
  return dates.addDays(dates.addMonths(start, months), -1) <= end;
}

function won(n) {
  return Number(n || 0).toLocaleString('ko-KR') + '원';
}

// 정산 실적을 연도별로 합산하고, 기준금액을 처음 넘긴 달을 찾는다.
function summarizeSettlements(settlements, project, threshold) {
  const rows = (settlements || [])
    .filter((s) => s.projectId === project.id)
    .sort((a, b) => a.month.localeCompare(b.month));
  const byYear = {};
  let total = 0;
  let triggerMonth = null;
  for (const r of rows) {
    const y = r.month.slice(0, 4);
    byYear[y] = (byYear[y] || 0) + Number(r.amount || 0);
    total += Number(r.amount || 0);
    if (!triggerMonth && byYear[y] >= threshold) triggerMonth = r.month;
  }
  return { rows, byYear, total, triggerMonth };
}

// 해당 연도 말(또는 계약 종료월)까지 월평균으로 누계를 단순 예측
function forecastYear(sum, year, project) {
  const months = sum.rows.filter((r) => r.month.startsWith(year));
  if (!months.length) return null;
  const cum = sum.byYear[year] || 0;
  const startM = project.startDate && project.startDate.slice(0, 4) === year ? project.startDate.slice(0, 7) : `${year}-01`;
  const endM = project.endDate && project.endDate.slice(0, 4) === year ? project.endDate.slice(0, 7) : `${year}-12`;
  const lastM = months[months.length - 1].month;
  const span = (a, b) => (+b.slice(0, 4) - +a.slice(0, 4)) * 12 + (+b.slice(5, 7) - +a.slice(5, 7)) + 1;
  const elapsed = Math.max(1, span(startM, lastM));
  const remaining = Math.max(0, span(lastM, endM) - 1);
  return Math.round(cum + (cum / elapsed) * remaining);
}

/**
 * @returns {{
 *   target: boolean, basis: string, reason: string, warning: boolean,
 *   cumulative?: object, ratio?: number, forecast?: number|null, triggerMonth?: string|null
 * }}
 */
function judge(project, settlements, rules = DEFAULT_RULES, today = dates.todayReal()) {
  const r = { ...DEFAULT_RULES, ...(rules || {}) };
  const amount = Number(project.amount || 0);
  const th = r.amountThreshold;
  const pOk = periodOk(project.startDate, project.endDate, r.periodMonths);

  if (project.type === 'GENERAL') {
    const aOk = amount >= th;
    const target = aOk && pOk;
    const parts = [
      `공사기간 ${project.startDate || '?'} ~ ${project.endDate || '?'} (${pOk ? r.periodMonths + '개월 이상' : r.periodMonths + '개월 미만'})`,
      `공사금액 ${won(amount)} (${aOk ? '기준 이상' : '기준 미만'})`,
    ];
    return {
      target,
      basis: target ? 'GENERAL' : 'NONE',
      reason: `[일반공사] ${parts.join(', ')} → ${target ? '기술지도 대상' : '대상 아님'}`,
      warning: false,
    };
  }

  // 단가계약
  const sum = summarizeSettlements(settlements, project, th);
  const year = today.slice(0, 4);
  const cumYear = sum.byYear[year] || 0;
  const maxYear = Math.max(0, ...Object.values(sum.byYear));
  const cumulative = { byYear: sum.byYear, total: sum.total, currentYear: year, currentYearAmount: cumYear, maxYearAmount: maxYear };

  if (amount >= th) {
    return {
      target: true,
      basis: 'UNIT_CONTRACT_AMOUNT',
      reason: `[단가계약] 계약금액 ${won(amount)} ≥ ${won(th)} → 기술지도 대상`,
      warning: false,
      cumulative,
      ratio: maxYear / th,
      forecast: forecastYear(sum, year, project),
      triggerMonth: null,
    };
  }
  if (sum.triggerMonth) {
    return {
      target: true,
      basis: 'UNIT_CUMULATIVE',
      reason: `[단가계약] 계약금액 ${won(amount)} < ${won(th)} 이나 ${sum.triggerMonth.slice(0, 4)}년 누적 정산금액 ${won(sum.byYear[sum.triggerMonth.slice(0, 4)])} ≥ ${won(th)} (${sum.triggerMonth} 초과) → 기술지도 대상`,
      warning: false,
      cumulative,
      ratio: maxYear / th,
      forecast: forecastYear(sum, year, project),
      triggerMonth: sum.triggerMonth,
    };
  }
  const ratio = maxYear / th;
  const forecast = forecastYear(sum, year, project);
  const warning = ratio >= r.warnRatio || (forecast != null && forecast >= th);
  let reason = `[단가계약] 계약금액 ${won(amount)} < ${won(th)}, ${year}년 누적 정산 ${won(cumYear)} (${(ratio * 100).toFixed(1)}%) → 대상 아님(누계 관리)`;
  if (warning) {
    reason += forecast != null && forecast >= th
      ? ` ※ 현 추세 연말 예상 누계 ${won(forecast)} — 1억원 초과 예상, 작업 세분화 또는 기술지도 계약 준비 필요`
      : ` ※ 누계가 기준의 ${Math.round(r.warnRatio * 100)}% 이상 — 주의`;
  }
  return { target: false, basis: 'NONE', reason, warning, cumulative, ratio, forecast, triggerMonth: null };
}

module.exports = { judge, periodOk, summarizeSettlements, DEFAULT_RULES, won };
