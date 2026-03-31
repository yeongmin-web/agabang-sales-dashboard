/**
 * Notion 월별 매출 현황(DB) → 차트 HTML 자동 생성 스크립트
 *
 * Notion DB(월별 매출 현황)에서 데이터를 조회하여
 * Chart.js 기반 인터랙티브 차트 HTML 파일을 생성합니다.
 *
 * 사용법: node generate-charts.js
 *
 * 생성 파일:
 *   - yoy-performance.html  (전년 대비 실적 종합)
 *   - plan-achievement.html (사업계획 달성율 종합)
 */

const fs = require('fs');
const path = require('path');

// ── 설정 ──
const NOTION_API_KEY = 'ntn_b44948436136gbc7K0aA5RhKDt7q4hybV2N454MFFX06CI';
const NOTION_DB_ID = '69ecba48f5d44fe0972dacc72af278d1'; // 월별 매출 현황(DB)
const NOTION_API = 'https://api.notion.com/v1';
const NOTION_HEADERS = {
  'Authorization': `Bearer ${NOTION_API_KEY}`,
  'Content-Type': 'application/json',
  'Notion-Version': '2022-06-28',
};
const OUTPUT_DIR = __dirname;

// ── 브랜드 → 사업부 매핑 ──
const BRAND_TO_DIV = {
  '아가방': '갤러리',
  '에뜨와': '에뜨와',
  '디즈니': '디즈니',
  '포래즈': '에뜨와',  // 포래즈는 에뜨와사업부 소속
};

// ── Notion API 헬퍼 ──
async function notionQuery(dbId, filter = {}, sorts = []) {
  const allResults = [];
  let startCursor = undefined;
  let hasMore = true;

  while (hasMore) {
    const body = { page_size: 100 };
    if (Object.keys(filter).length > 0) body.filter = filter;
    if (sorts.length > 0) body.sorts = sorts;
    if (startCursor) body.start_cursor = startCursor;

    const res = await fetch(`${NOTION_API}/databases/${dbId}/query`, {
      method: 'POST',
      headers: NOTION_HEADERS,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Notion API ${res.status}: ${text}`);
    }

    const data = await res.json();
    allResults.push(...data.results);
    hasMore = data.has_more;
    startCursor = data.next_cursor;
  }

  return allResults;
}

// ── Notion 페이지에서 속성 추출 ──
function extractProps(page) {
  const p = page.properties;
  return {
    항목: p['항목']?.title?.[0]?.plain_text || '',
    연도: p['연도']?.select?.name || '',
    월: p['월']?.select?.name || '',
    브랜드: p['브랜드']?.select?.name || '',
    채널: p['채널']?.select?.name || '',
    실매출: p['실매출']?.number || 0,
    전년실매출: p['전년실매출']?.number || 0,
    목표매출: p['목표매출']?.number || 0,
    달성율: p['달성율']?.number || 0,
    성장율: p['성장율']?.number || 0,
  };
}

// ── 데이터 집계 ──
function aggregateData(records) {
  // 2026년 오프라인+온라인 데이터 합산 (합계 채널이 없는 경우 대비)
  const current = records.filter(r => r.연도 === '2026' && r.채널 !== '합계');

  // 사업부별 집계
  const divisions = {};

  for (const r of current) {
    const brand = r.브랜드;
    if (brand === '전체' || brand === '기타') continue;

    const divName = BRAND_TO_DIV[brand] || brand;

    if (!divisions[divName]) {
      divisions[divName] = {
        name: divName,
        actualSales: 0,
        prevSales: 0,
        targetSales: 0,
      };
    }

    divisions[divName].actualSales += r.실매출;
    divisions[divName].prevSales += r.전년실매출;
    divisions[divName].targetSales += r.목표매출;
  }

  return divisions;
}

// ── 채널별 집계 (온라인/오프라인 분리) ──
function aggregateByChannel(records) {
  const current = records.filter(r => r.연도 === '2026');
  const result = {};

  for (const r of current) {
    const brand = r.브랜드;
    if (brand === '전체' || brand === '기타') continue;
    if (r.채널 === '합계') continue;

    const divName = BRAND_TO_DIV[brand] || brand;
    const key = `${divName}_${r.채널}`;

    if (!result[key]) {
      result[key] = {
        division: divName,
        channel: r.채널,
        actualSales: 0,
        prevSales: 0,
        targetSales: 0,
      };
    }

    result[key].actualSales += r.실매출;
    result[key].prevSales += r.전년실매출;
    result[key].targetSales += r.목표매출;
  }

  return result;
}

// ── 영업이익 데이터 (Notion DB에 없으므로 하드코딩 유지) ──
const PROFIT_DATA = {
  '갤러리': { profit2025: 1354, profit2026: 1282 },
  '에뜨와': { profit2025: 733, profit2026: 1224 },
  '디즈니': { profit2025: -250, profit2026: 84 },
};

// ── 차트 1: 전년 대비 실적 종합 (yoy-performance.html) ──
function generateYoYChart(divisions) {
  const divOrder = ['갤러리', '에뜨와', '디즈니'];
  const divs = divOrder.map(name => divisions[name]).filter(Boolean);

  // 임대, 온라인(별도), 화장품은 Notion DB에 브랜드로 없으므로
  // 합계 데이터에서 추출할 수 없음 → 사업부 매핑된 것만 표시

  const labels = divs.map(d => d.name + '사업부');
  const prevSalesArr = divs.map(d => Math.round(d.prevSales / 1000000)); // 원 → 백만원
  const actualSalesArr = divs.map(d => Math.round(d.actualSales / 1000000));
  const changes = divs.map(d => {
    const pct = d.prevSales > 0 ? ((d.actualSales - d.prevSales) / d.prevSales * 100).toFixed(1) : '0.0';
    return (pct >= 0 ? '+' : '') + pct + '%';
  });

  // 영업이익 데이터
  const prevProfitArr = divs.map(d => PROFIT_DATA[d.name]?.profit2025 || 0);
  const actualProfitArr = divs.map(d => PROFIT_DATA[d.name]?.profit2026 || 0);

  // 총합계 계산
  const totalActual = actualSalesArr.reduce((a, b) => a + b, 0);
  const totalPrev = prevSalesArr.reduce((a, b) => a + b, 0);
  const totalChange = totalPrev > 0 ? ((totalActual - totalPrev) / totalPrev * 100).toFixed(1) : '0.0';
  const totalProfitChange = actualProfitArr.reduce((a, b) => a + b, 0) - prevProfitArr.reduce((a, b) => a + b, 0);

  const now = new Date().toISOString().split('T')[0];

  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>사업부별 전년 대비 실적</title>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
  <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #F8FAFC;
      display: flex; justify-content: center; align-items: center;
      min-height: 100vh;
      font-family: 'Noto Sans KR', -apple-system, sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    .card {
      background: #fff;
      border-radius: 20px;
      padding: 36px 40px 28px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.04), 0 8px 24px rgba(0,0,0,0.06);
      width: 920px;
      max-width: 96vw;
    }
    .header { margin-bottom: 28px; }
    .title {
      font-size: 22px; font-weight: 700; color: #0F172A;
      letter-spacing: -0.3px;
    }
    .subtitle {
      font-size: 13px; font-weight: 400; color: #94A3B8;
      margin-top: 6px; display: flex; gap: 16px; align-items: center;
    }
    .subtitle .tag {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 2px 10px; border-radius: 20px; font-size: 11px; font-weight: 600;
    }
    .tag-up { background: #ECFDF5; color: #059669; }
    .tag-profit { background: #EFF6FF; color: #2563EB; }
    .tag-down { background: #FEF2F2; color: #DC2626; }
    .chart-area { position: relative; height: 440px; }
    .legend-custom {
      display: flex; justify-content: center; gap: 24px;
      margin-top: 16px; flex-wrap: wrap;
    }
    .legend-item {
      display: flex; align-items: center; gap: 6px;
      font-size: 12px; font-weight: 500; color: #64748B;
    }
    .legend-bar { width: 14px; height: 10px; border-radius: 3px; }
    .legend-line { width: 20px; height: 3px; border-radius: 2px; }
    .legend-line.dashed { background: repeating-linear-gradient(90deg, currentColor 0 6px, transparent 6px 10px); height: 2px; }
    .updated { font-size: 11px; color: #CBD5E1; text-align: right; margin-top: 12px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <div class="title">사업부별 전년 대비 실적</div>
      <div class="subtitle">
        <span>막대: 매출액 &nbsp;|&nbsp; 선: 영업이익 &nbsp;|&nbsp; 단위: 백만원</span>
        <span class="tag ${parseFloat(totalChange) >= 0 ? 'tag-up' : 'tag-down'}">매출 ${parseFloat(totalChange) >= 0 ? '+' : ''}${totalChange}%</span>
        <span class="tag tag-profit">영업이익 ${totalProfitChange >= 0 ? '+' : ''}${totalProfitChange.toLocaleString()}</span>
      </div>
    </div>
    <div class="chart-area"><canvas id="chart"></canvas></div>
    <div class="legend-custom">
      <div class="legend-item"><div class="legend-bar" style="background:#CBD5E1"></div>2025 매출액</div>
      <div class="legend-item"><div class="legend-bar" style="background:#6366F1"></div>2026 매출액</div>
      <div class="legend-item"><div class="legend-line dashed" style="color:#FBBF24"></div>2025 영업이익</div>
      <div class="legend-item"><div class="legend-line" style="background:#10B981"></div>2026 영업이익</div>
    </div>
    <div class="updated">데이터 출처: Notion 월별 매출 현황(DB) | 갱신일: ${now}</div>
  </div>
  <script>
    const ctx = document.getElementById('chart').getContext('2d');
    const labels = ${JSON.stringify(labels)};
    const changes = ${JSON.stringify(changes)};

    new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: '2025 매출액',
            data: ${JSON.stringify(prevSalesArr)},
            backgroundColor: '#E2E8F0',
            hoverBackgroundColor: '#CBD5E1',
            borderRadius: 6,
            barPercentage: 0.68,
            categoryPercentage: 0.62,
            order: 3,
            yAxisID: 'y'
          },
          {
            label: '2026 매출액',
            data: ${JSON.stringify(actualSalesArr)},
            backgroundColor: '#6366F1',
            hoverBackgroundColor: '#4F46E5',
            borderRadius: 6,
            barPercentage: 0.68,
            categoryPercentage: 0.62,
            order: 3,
            yAxisID: 'y'
          },
          {
            label: '2025 영업이익',
            type: 'line',
            data: ${JSON.stringify(prevProfitArr)},
            borderColor: '#FBBF24',
            borderWidth: 2.5,
            borderDash: [7, 4],
            pointRadius: 5,
            pointHoverRadius: 8,
            pointBackgroundColor: '#FBBF24',
            pointBorderColor: '#fff',
            pointBorderWidth: 2.5,
            fill: false,
            tension: 0.35,
            order: 1,
            yAxisID: 'y1'
          },
          {
            label: '2026 영업이익',
            type: 'line',
            data: ${JSON.stringify(actualProfitArr)},
            borderColor: '#10B981',
            borderWidth: 3,
            pointRadius: 6,
            pointHoverRadius: 9,
            pointBackgroundColor: '#10B981',
            pointBorderColor: '#fff',
            pointBorderWidth: 2.5,
            fill: false,
            tension: 0.35,
            order: 1,
            yAxisID: 'y1'
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 900, easing: 'easeOutQuart' },
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: 'rgba(15,23,42,0.92)',
            titleFont: { family: "'Noto Sans KR'", size: 13, weight: '600' },
            bodyFont: { family: "'Noto Sans KR'", size: 12 },
            padding: { top: 12, bottom: 12, left: 16, right: 16 },
            cornerRadius: 10,
            boxPadding: 6,
            usePointStyle: true,
            callbacks: {
              title: function(items) {
                const idx = items[0].dataIndex;
                return items[0].label + '  ' + changes[idx];
              },
              label: function(ctx) {
                const v = ctx.parsed.y ?? ctx.parsed;
                return ' ' + ctx.dataset.label + ': ' + v.toLocaleString() + ' 백만원';
              }
            }
          }
        },
        scales: {
          y: {
            position: 'left',
            title: { display: true, text: '매출액 (백만원)', font: { family: "'Noto Sans KR'", size: 11, weight: '500' }, color: '#94A3B8', padding: { bottom: 8 } },
            beginAtZero: true,
            grid: { color: '#F1F5F9', lineWidth: 1 },
            border: { display: false },
            ticks: {
              font: { family: "'Noto Sans KR'", size: 10 }, color: '#CBD5E1', maxTicksLimit: 6,
              callback: function(v) { return (v / 1000).toFixed(0) + 'K'; }
            }
          },
          y1: {
            position: 'right',
            title: { display: true, text: '영업이익 (백만원)', font: { family: "'Noto Sans KR'", size: 11, weight: '500' }, color: '#94A3B8', padding: { bottom: 8 } },
            grid: { display: false },
            border: { display: false },
            ticks: {
              font: { family: "'Noto Sans KR'", size: 10 }, color: '#CBD5E1', maxTicksLimit: 6,
              callback: function(v) { return v.toLocaleString(); }
            }
          },
          x: {
            grid: { display: false },
            border: { display: false },
            ticks: { font: { family: "'Noto Sans KR'", size: 13, weight: '600' }, color: '#334155', padding: 8 }
          }
        }
      }
    });
  </script>
</body>
</html>`;
}

// ── 차트 2: 사업계획 달성율 종합 (plan-achievement.html) ──
function generatePlanChart(divisions) {
  const divOrder = ['갤러리', '에뜨와', '디즈니'];
  const divs = divOrder.map(name => divisions[name]).filter(Boolean);

  const labels = divs.map(d => d.name + '사업부');
  const planSalesArr = divs.map(d => Math.round(d.targetSales / 1000000));
  const actualSalesArr = divs.map(d => Math.round(d.actualSales / 1000000));
  const rates = divs.map(d => d.targetSales > 0
    ? (d.actualSales / d.targetSales * 100).toFixed(1) + '%'
    : '-');
  const diffs = divs.map(d => {
    const diff = Math.round((d.actualSales - d.targetSales) / 1000000);
    return (diff >= 0 ? '+' : '') + diff.toLocaleString();
  });

  // 영업이익 (하드코딩)
  const planProfitMap = { '갤러리': 1579, '에뜨와': 1351, '디즈니': -132 };
  const actualProfitMap = { '갤러리': 1282, '에뜨와': 1224, '디즈니': 84 };
  const planProfitArr = divs.map(d => planProfitMap[d.name] || 0);
  const actualProfitArr = divs.map(d => actualProfitMap[d.name] || 0);

  // 전사 달성율
  const totalPlan = planSalesArr.reduce((a, b) => a + b, 0);
  const totalActual = actualSalesArr.reduce((a, b) => a + b, 0);
  const totalRate = totalPlan > 0 ? (totalActual / totalPlan * 100).toFixed(1) : '0.0';

  const now = new Date().toISOString().split('T')[0];

  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>사업부별 사업계획 대비 달성율</title>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/chartjs-plugin-annotation/3.0.1/chartjs-plugin-annotation.min.js"></script>
  <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #F8FAFC;
      display: flex; justify-content: center; align-items: center;
      min-height: 100vh;
      font-family: 'Noto Sans KR', -apple-system, sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    .card {
      background: #fff;
      border-radius: 20px;
      padding: 36px 40px 28px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.04), 0 8px 24px rgba(0,0,0,0.06);
      width: 920px;
      max-width: 96vw;
    }
    .header { margin-bottom: 28px; }
    .title {
      font-size: 22px; font-weight: 700; color: #0F172A;
      letter-spacing: -0.3px;
    }
    .subtitle {
      font-size: 13px; font-weight: 400; color: #94A3B8;
      margin-top: 6px; display: flex; gap: 12px; align-items: center;
    }
    .tag {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 2px 10px; border-radius: 20px; font-size: 11px; font-weight: 600;
    }
    .tag-green { background: #ECFDF5; color: #059669; }
    .tag-red { background: #FEF2F2; color: #DC2626; }
    .chart-area { position: relative; height: 460px; }
    .legend-custom {
      display: flex; justify-content: center; gap: 24px;
      margin-top: 16px; flex-wrap: wrap;
    }
    .legend-item {
      display: flex; align-items: center; gap: 6px;
      font-size: 12px; font-weight: 500; color: #64748B;
    }
    .legend-bar { width: 14px; height: 10px; border-radius: 3px; }
    .legend-line-dashed {
      width: 22px; height: 0; border-top: 2px dashed #EF4444;
    }
    .updated { font-size: 11px; color: #CBD5E1; text-align: right; margin-top: 12px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <div class="title">사업부별 사업계획 대비 달성율</div>
      <div class="subtitle">
        <span>사업계획 vs 실적 매출액 &nbsp;|&nbsp; 단위: 백만원</span>
        <span class="tag ${parseFloat(totalRate) >= 100 ? 'tag-green' : 'tag-red'}">전사 달성율 ${totalRate}%</span>
      </div>
    </div>
    <div class="chart-area"><canvas id="chart"></canvas></div>
    <div class="legend-custom">
      <div class="legend-item"><div class="legend-bar" style="background:#CBD5E1"></div>사업계획 매출액</div>
      <div class="legend-item"><div class="legend-bar" style="background:#6366F1"></div>실적 매출액</div>
      <div class="legend-item"><div class="legend-bar" style="background:#E2E8F0"></div>사업계획 영업이익</div>
      <div class="legend-item"><div class="legend-bar" style="background:#10B981"></div>실적 영업이익</div>
      <div class="legend-item"><div class="legend-line-dashed"></div>100% 기준선</div>
    </div>
    <div class="updated">데이터 출처: Notion 월별 매출 현황(DB) | 갱신일: ${now}</div>
  </div>
  <script>
    const ctx = document.getElementById('chart').getContext('2d');
    const labels = ${JSON.stringify(labels)};
    const planSales = ${JSON.stringify(planSalesArr)};
    const actualSales = ${JSON.stringify(actualSalesArr)};
    const planProfit = ${JSON.stringify(planProfitArr)};
    const actualProfit = ${JSON.stringify(actualProfitArr)};
    const rates = ${JSON.stringify(rates)};
    const diffs = ${JSON.stringify(diffs)};

    new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: '사업계획 매출액',
            data: planSales,
            backgroundColor: '#CBD5E1',
            hoverBackgroundColor: '#94A3B8',
            borderRadius: 6,
            barPercentage: 0.7,
            categoryPercentage: 0.62,
            order: 2,
            yAxisID: 'y'
          },
          {
            label: '실적 매출액',
            data: actualSales,
            backgroundColor: '#6366F1',
            hoverBackgroundColor: '#4F46E5',
            borderRadius: 6,
            barPercentage: 0.7,
            categoryPercentage: 0.62,
            order: 2,
            yAxisID: 'y'
          },
          {
            label: '사업계획 영업이익',
            type: 'line',
            data: planProfit,
            borderColor: '#94A3B8',
            borderWidth: 2,
            borderDash: [6, 3],
            pointRadius: 4,
            pointHoverRadius: 7,
            pointBackgroundColor: '#94A3B8',
            pointBorderColor: '#fff',
            pointBorderWidth: 2,
            fill: false,
            tension: 0.35,
            order: 1,
            yAxisID: 'y1'
          },
          {
            label: '실적 영업이익',
            type: 'line',
            data: actualProfit,
            borderColor: '#10B981',
            borderWidth: 3,
            pointRadius: 6,
            pointHoverRadius: 9,
            pointBackgroundColor: '#10B981',
            pointBorderColor: '#fff',
            pointBorderWidth: 2.5,
            fill: false,
            tension: 0.35,
            order: 1,
            yAxisID: 'y1'
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 900, easing: 'easeOutQuart' },
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          annotation: {
            annotations: {}
          },
          tooltip: {
            backgroundColor: 'rgba(15,23,42,0.92)',
            titleFont: { family: "'Noto Sans KR'", size: 13, weight: '600' },
            bodyFont: { family: "'Noto Sans KR'", size: 12 },
            footerFont: { family: "'Noto Sans KR'", size: 11, weight: '600' },
            padding: { top: 12, bottom: 12, left: 16, right: 16 },
            cornerRadius: 10,
            boxPadding: 6,
            usePointStyle: true,
            callbacks: {
              title: function(items) {
                return items[0].label;
              },
              label: function(ctx) {
                const v = ctx.parsed.y ?? ctx.parsed;
                return ' ' + ctx.dataset.label + ': ' + v.toLocaleString() + ' 백만원';
              },
              footer: function(items) {
                const idx = items[0].dataIndex;
                return '달성율: ' + rates[idx] + '  |  증감: ' + diffs[idx];
              }
            }
          }
        },
        scales: {
          y: {
            position: 'left',
            title: { display: true, text: '매출액 (백만원)', font: { family: "'Noto Sans KR'", size: 11, weight: '500' }, color: '#94A3B8', padding: { bottom: 8 } },
            beginAtZero: true,
            grid: { color: '#F1F5F9', lineWidth: 1 },
            border: { display: false },
            ticks: {
              font: { family: "'Noto Sans KR'", size: 10 }, color: '#CBD5E1', maxTicksLimit: 6,
              callback: function(v) { return (v / 1000).toFixed(0) + 'K'; }
            }
          },
          y1: {
            position: 'right',
            title: { display: true, text: '영업이익 (백만원)', font: { family: "'Noto Sans KR'", size: 11, weight: '500' }, color: '#94A3B8', padding: { bottom: 8 } },
            grid: { display: false },
            border: { display: false },
            ticks: {
              font: { family: "'Noto Sans KR'", size: 10 }, color: '#CBD5E1', maxTicksLimit: 6,
              callback: function(v) { return v.toLocaleString(); }
            }
          },
          x: {
            grid: { display: false },
            border: { display: false },
            ticks: { font: { family: "'Noto Sans KR'", size: 13, weight: '600' }, color: '#334155', padding: 8 }
          }
        }
      }
    });
  </script>
</body>
</html>`;
}

// ── Git 자동 커밋 & 푸시 ──
function gitAutoPush() {
  const { execSync } = require('child_process');
  const opts = { cwd: OUTPUT_DIR, encoding: 'utf8', timeout: 30000 };

  try {
    execSync('git add yoy-performance.html plan-achievement.html', opts);
    const staged = execSync('git diff --cached --name-only', opts).trim();
    if (!staged) {
      console.log('  → 변경사항 없음, push 생략');
      return;
    }

    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    execSync(`git commit -m "차트 데이터 자동 갱신: ${now}"`, opts);
    execSync('git push', opts);
    console.log('  ✓ GitHub Pages push 완료');
  } catch (err) {
    console.error('  ✗ Git push 실패:', err.message);
  }
}

// ── 메인 실행 ──
async function main() {
  console.log('=== Notion 월별 매출 현황(DB) → 차트 생성 스크립트 ===');
  console.log(`실행 시각: ${new Date().toISOString()}`);

  // 1. Notion DB 데이터 조회
  console.log('\n[1/4] Notion DB 조회 중...');
  const filter = {
    property: '연도',
    select: { equals: '2026' }
  };
  const records2026 = await notionQuery(NOTION_DB_ID, filter);
  console.log(`  → 2026년 데이터 ${records2026.length}건 조회`);

  const allRecords = records2026.map(extractProps);
  console.log(`  → 파싱 완료: ${allRecords.length}건`);

  // 데이터 샘플 출력
  console.log('\n[데이터 샘플]');
  allRecords.slice(0, 3).forEach(r => {
    console.log(`  ${r.브랜드} / ${r.채널} / ${r.월}: 실매출=${r.실매출.toLocaleString()}, 전년=${r.전년실매출.toLocaleString()}, 목표=${r.목표매출.toLocaleString()}`);
  });

  // 2. 사업부별 집계
  console.log('\n[2/4] 데이터 집계 중...');
  const divisions = aggregateData(allRecords);

  console.log('\n[사업부별 집계 결과] (단위: 백만원)');
  for (const [name, d] of Object.entries(divisions)) {
    const rate = d.targetSales > 0 ? (d.actualSales / d.targetSales * 100).toFixed(1) : '-';
    console.log(`  ${name}: 실적=${Math.round(d.actualSales/1000000)}, 전년=${Math.round(d.prevSales/1000000)}, 목표=${Math.round(d.targetSales/1000000)}, 달성율=${rate}%`);
  }

  // 3. 차트 HTML 생성
  console.log('\n[3/4] 차트 HTML 생성 중...');

  const yoyHtml = generateYoYChart(divisions);
  const yoyPath = path.join(OUTPUT_DIR, 'yoy-performance.html');
  fs.writeFileSync(yoyPath, yoyHtml, 'utf8');
  console.log(`  ✓ ${yoyPath}`);

  const planHtml = generatePlanChart(divisions);
  const planPath = path.join(OUTPUT_DIR, 'plan-achievement.html');
  fs.writeFileSync(planPath, planHtml, 'utf8');
  console.log(`  ✓ ${planPath}`);

  // 4. Git 자동 push
  console.log('\n[4/4] GitHub Pages 배포 중...');
  gitAutoPush();

  console.log('\n=== 완료 ===');
}

main().catch(err => {
  console.error('오류 발생:', err);
  process.exit(1);
});
