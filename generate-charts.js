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
const ONOFF_DB_ID = '99f1d2485ee041b3bd484f02bbeaa033'; // 온오프 목표대비 실적
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
      padding: 12px;
    }
    .card {
      background: #fff;
      border-radius: 20px;
      padding: 36px 40px 28px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.04), 0 8px 24px rgba(0,0,0,0.06);
      width: 100%;
      max-width: 920px;
    }
    .header { margin-bottom: 28px; }
    .title {
      font-size: 22px; font-weight: 700; color: #0F172A;
      letter-spacing: -0.3px;
    }
    .subtitle {
      font-size: 13px; font-weight: 400; color: #94A3B8;
      margin-top: 6px; display: flex; gap: 16px; align-items: center;
      flex-wrap: wrap;
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
    @media (max-width: 640px) {
      .card { padding: 20px 16px 16px; border-radius: 12px; }
      .title { font-size: 18px; }
      .subtitle { font-size: 12px; gap: 8px; }
      .chart-area { height: 300px; }
      .legend-custom { gap: 12px; }
      .legend-item { font-size: 11px; }
    }
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
      padding: 12px;
    }
    .card {
      background: #fff;
      border-radius: 20px;
      padding: 36px 40px 28px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.04), 0 8px 24px rgba(0,0,0,0.06);
      width: 100%;
      max-width: 920px;
    }
    .header { margin-bottom: 28px; }
    .title {
      font-size: 22px; font-weight: 700; color: #0F172A;
      letter-spacing: -0.3px;
    }
    .subtitle {
      font-size: 13px; font-weight: 400; color: #94A3B8;
      margin-top: 6px; display: flex; gap: 12px; align-items: center;
      flex-wrap: wrap;
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
    @media (max-width: 640px) {
      .card { padding: 20px 16px 16px; border-radius: 12px; }
      .title { font-size: 18px; }
      .subtitle { font-size: 12px; gap: 8px; }
      .chart-area { height: 320px; }
      .legend-custom { gap: 12px; }
      .legend-item { font-size: 11px; }
    }
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
    execSync('git add yoy-performance.html plan-achievement.html onoff-dashboard.html', opts);
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

// ── 온오프 목표대비 실적 DB 조회 ──
function extractOnoffProps(page) {
  const p = page.properties;
  return {
    년월: p['년월']?.title?.[0]?.plain_text || '',
    온오프구분: p['온오프구분']?.select?.name || '',
    브랜드: p['브랜드']?.select?.name || '',
    실매출: p['실매출']?.number || 0,
    목표: p['목표']?.number || 0,
    전년매출: p['전년매출']?.number || 0,
    달성율: p['달성율']?.number || 0,
    성장율: p['성장율']?.number || 0,
  };
}

function aggregateOnoffByMonth(records, year) {
  const months = [];
  for (let m = 1; m <= 12; m++) {
    const ym = `${year}${String(m).padStart(2, '0')}`;
    const offRecs = records.filter(r => r.년월 === ym && r.온오프구분 === 'offline');
    const onRecs = records.filter(r => r.년월 === ym && r.온오프구분 === 'online');

    if (offRecs.length === 0 && onRecs.length === 0) continue;

    const offSales = offRecs.reduce((s, r) => s + r.실매출, 0);
    const offTarget = offRecs.reduce((s, r) => s + r.목표, 0);
    const offPrev = offRecs.reduce((s, r) => s + r.전년매출, 0);
    const onSales = onRecs.reduce((s, r) => s + r.실매출, 0);
    const onTarget = onRecs.reduce((s, r) => s + r.목표, 0);
    const onPrev = onRecs.reduce((s, r) => s + r.전년매출, 0);

    months.push({
      month: m,
      label: `${m}월`,
      offSales, offTarget, offPrev,
      onSales, onTarget, onPrev,
      offAchieve: offTarget > 0 ? (offSales / offTarget * 100) : 0,
      onAchieve: onTarget > 0 ? (onSales / onTarget * 100) : 0,
      offGrowth: offPrev > 0 ? ((offSales - offPrev) / offPrev * 100) : 0,
      onGrowth: onPrev > 0 ? ((onSales - onPrev) / onPrev * 100) : 0,
    });
  }
  return months;
}

// ── 브랜드별 월별 집계 ──
function aggregateOnoffByBrand(records, year) {
  const brands = ['아가방', '에뜨와', '디즈니'];
  const result = {};

  for (const brand of brands) {
    const brandRecords = records.filter(r => r.브랜드 === brand);
    const months = [];
    for (let m = 1; m <= 12; m++) {
      const ym = `${year}${String(m).padStart(2, '0')}`;
      const recs = brandRecords.filter(r => r.년월 === ym);
      if (recs.length === 0) continue;

      const offRecs = recs.filter(r => r.온오프구분 === 'offline');
      const onRecs = recs.filter(r => r.온오프구분 === 'online');
      const totalSales = recs.reduce((s, r) => s + r.실매출, 0);
      const totalTarget = recs.reduce((s, r) => s + r.목표, 0);
      const totalPrev = recs.reduce((s, r) => s + r.전년매출, 0);

      months.push({
        month: m, label: `${m}월`,
        totalSales, totalTarget, totalPrev,
        offSales: offRecs.reduce((s, r) => s + r.실매출, 0),
        onSales: onRecs.reduce((s, r) => s + r.실매출, 0),
        achieve: totalTarget > 0 ? (totalSales / totalTarget * 100) : 0,
        growth: totalPrev > 0 ? ((totalSales - totalPrev) / totalPrev * 100) : 0,
      });
    }

    const totalSales = months.reduce((s, m) => s + m.totalSales, 0);
    const totalTarget = months.reduce((s, m) => s + m.totalTarget, 0);
    const totalPrev = months.reduce((s, m) => s + m.totalPrev, 0);

    result[brand] = {
      months,
      totalSales,
      totalTarget,
      totalPrev,
      achieve: totalTarget > 0 ? (totalSales / totalTarget * 100) : 0,
      growth: totalPrev > 0 ? ((totalSales - totalPrev) / totalPrev * 100) : 0,
    };
  }
  return result;
}

// ── 차트 3: 온오프 매출 현황 대시보드 (onoff-dashboard.html) ──
function generateOnoffDashboard(monthlyData, year, brandData) {
  const now = new Date().toISOString().split('T')[0];
  const labels = monthlyData.map(m => m.label);

  // 억원 변환 (소수 1자리)
  const toEok = v => +(v / 100000000).toFixed(1);

  const offSales = monthlyData.map(m => toEok(m.offSales));
  const offTarget = monthlyData.map(m => toEok(m.offTarget));
  const onSales = monthlyData.map(m => toEok(m.onSales));
  const onTarget = monthlyData.map(m => toEok(m.onTarget));
  const offAchieve = monthlyData.map(m => +m.offAchieve.toFixed(1));
  const onAchieve = monthlyData.map(m => +m.onAchieve.toFixed(1));
  const offGrowth = monthlyData.map(m => +m.offGrowth.toFixed(1));
  const onGrowth = monthlyData.map(m => +m.onGrowth.toFixed(1));

  // KPI 계산
  const totalOffSales = toEok(monthlyData.reduce((s, m) => s + m.offSales, 0));
  const totalOnSales = toEok(monthlyData.reduce((s, m) => s + m.onSales, 0));
  const totalSales = +(totalOffSales + totalOnSales).toFixed(1);
  const totalOffTarget = monthlyData.reduce((s, m) => s + m.offTarget, 0);
  const totalOnTarget = monthlyData.reduce((s, m) => s + m.onTarget, 0);
  const totalOffActual = monthlyData.reduce((s, m) => s + m.offSales, 0);
  const totalOnActual = monthlyData.reduce((s, m) => s + m.onSales, 0);
  const offAchieveTotal = totalOffTarget > 0 ? (totalOffActual / totalOffTarget * 100).toFixed(1) : '0';
  const onAchieveTotal = totalOnTarget > 0 ? (totalOnActual / totalOnTarget * 100).toFixed(1) : '0';
  const totalPrev = monthlyData.reduce((s, m) => s + m.offPrev + m.onPrev, 0);
  const totalActual = totalOffActual + totalOnActual;
  const totalGrowth = totalPrev > 0 ? ((totalActual - totalPrev) / totalPrev * 100).toFixed(1) : '0';

  // 목표 초과 달성 월 카운트
  const offOverMonths = monthlyData.filter(m => m.offAchieve >= 100).length;
  const onOverMonths = monthlyData.filter(m => m.onAchieve >= 100).length;

  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>온오프 매출 현황 대시보드</title>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/chartjs-plugin-annotation/3.0.1/chartjs-plugin-annotation.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/chartjs-plugin-datalabels/2.2.0/chartjs-plugin-datalabels.min.js"></script>
  <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #F8FAFC;
      font-family: 'Noto Sans KR', -apple-system, sans-serif;
      -webkit-font-smoothing: antialiased;
      padding: 24px 16px;
    }
    .dashboard {
      max-width: 960px;
      margin: 0 auto;
      width: 100%;
    }
    .dash-header {
      text-align: center;
      margin-bottom: 24px;
    }
    .dash-title {
      font-size: 24px; font-weight: 700; color: #0F172A;
      letter-spacing: -0.5px;
    }
    .dash-sub {
      font-size: 13px; color: #94A3B8; margin-top: 4px;
    }
    /* KPI Cards */
    .kpi-row {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 12px;
      margin-bottom: 20px;
    }
    .kpi-card {
      background: #fff;
      border-radius: 14px;
      padding: 18px 20px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.04);
    }
    .kpi-label {
      font-size: 12px; font-weight: 500; color: #64748B;
      display: flex; align-items: center; gap: 6px;
      margin-bottom: 6px;
    }
    .kpi-icon { font-size: 16px; }
    .kpi-value {
      font-size: 26px; font-weight: 700; color: #0F172A;
      letter-spacing: -0.5px;
    }
    .kpi-unit { font-size: 14px; font-weight: 500; color: #94A3B8; margin-left: 2px; }
    .kpi-desc {
      font-size: 11px; color: #94A3B8; margin-top: 4px;
    }
    .kpi-badge {
      display: inline-block;
      padding: 1px 8px; border-radius: 10px;
      font-size: 11px; font-weight: 600;
    }
    .badge-green { background: #ECFDF5; color: #059669; }
    .badge-red { background: #FEF2F2; color: #DC2626; }
    .badge-blue { background: #EFF6FF; color: #2563EB; }
    /* Chart Cards */
    .chart-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      margin-bottom: 16px;
    }
    .chart-card {
      background: #fff;
      border-radius: 16px;
      padding: 24px 24px 16px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.04);
    }
    .chart-card.full { grid-column: 1 / -1; }
    .chart-card-title {
      font-size: 15px; font-weight: 600; color: #1E293B;
      margin-bottom: 4px;
    }
    .chart-card-sub {
      font-size: 11px; color: #94A3B8; margin-bottom: 14px;
    }
    .chart-wrap { position: relative; height: 260px; }
    .chart-wrap.tall { height: 320px; }
    .chart-legend {
      display: flex; justify-content: center; gap: 16px;
      margin-top: 10px; flex-wrap: wrap;
    }
    .legend-i {
      display: flex; align-items: center; gap: 5px;
      font-size: 11px; font-weight: 500; color: #64748B;
    }
    .legend-dot { width: 10px; height: 10px; border-radius: 3px; }
    .legend-line { width: 18px; height: 3px; border-radius: 2px; }
    .updated {
      text-align: center;
      font-size: 11px; color: #CBD5E1; margin-top: 16px;
    }
    .brand-kpi { grid-template-columns: repeat(3, 1fr); }
    @media (max-width: 768px) {
      body { padding: 12px 8px; }
      .dash-title { font-size: 20px; }
      .dash-sub { font-size: 12px; }
      .kpi-row { grid-template-columns: repeat(2, 1fr); gap: 8px; }
      .brand-kpi { grid-template-columns: repeat(2, 1fr); }
      .kpi-value { font-size: 20px; }
      .kpi-card { padding: 14px 16px; }
      .chart-grid { grid-template-columns: 1fr; }
      .chart-card { padding: 16px 16px 12px; border-radius: 12px; }
      .chart-wrap { height: 220px; }
      .chart-legend { gap: 10px; }
    }
    @media (max-width: 480px) {
      .kpi-row { grid-template-columns: 1fr; }
      .brand-kpi { grid-template-columns: 1fr; }
      .kpi-value { font-size: 18px; }
      .chart-wrap { height: 200px; }
      .dash-title { font-size: 18px; }
    }
  </style>
</head>
<body>
  <div class="dashboard">
    <div class="dash-header">
      <div class="dash-title">${year}년 온오프 매출 현황 대시보드</div>
      <div class="dash-sub">전 브랜드 통합 | 단위: 억원 | 데이터 출처: Notion 온오프 목표대비 실적 DB</div>
    </div>

    <!-- KPI Cards -->
    <div class="kpi-row">
      <div class="kpi-card">
        <div class="kpi-label"><span class="kpi-icon">🏬</span> 오프라인 매출</div>
        <div class="kpi-value">${totalOffSales.toLocaleString()}<span class="kpi-unit">억</span></div>
        <div class="kpi-desc">달성율 <span class="kpi-badge ${parseFloat(offAchieveTotal) >= 95 ? 'badge-green' : 'badge-red'}">${offAchieveTotal}%</span></div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label"><span class="kpi-icon">💻</span> 온라인 매출</div>
        <div class="kpi-value">${totalOnSales.toLocaleString()}<span class="kpi-unit">억</span></div>
        <div class="kpi-desc">달성율 <span class="kpi-badge ${parseFloat(onAchieveTotal) >= 95 ? 'badge-green' : 'badge-red'}">${onAchieveTotal}%</span></div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label"><span class="kpi-icon">💰</span> 총 매출액</div>
        <div class="kpi-value">${totalSales.toLocaleString()}<span class="kpi-unit">억</span></div>
        <div class="kpi-desc">전년 대비 <span class="kpi-badge ${parseFloat(totalGrowth) >= 0 ? 'badge-green' : 'badge-red'}">${parseFloat(totalGrowth) >= 0 ? '+' : ''}${totalGrowth}%</span></div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label"><span class="kpi-icon">🎯</span> 목표 초과 달성</div>
        <div class="kpi-value">OFF ${offOverMonths} / ON ${onOverMonths}<span class="kpi-unit">개월</span></div>
        <div class="kpi-desc">총 ${monthlyData.length}개월 중</div>
      </div>
    </div>

    <!-- Charts Row 1: 오프라인 / 온라인 매출 -->
    <div class="chart-grid">
      <div class="chart-card">
        <div class="chart-card-title">월별 오프라인 매출</div>
        <div class="chart-card-sub">실매출 vs 목표 (억원)</div>
        <div class="chart-wrap"><canvas id="chartOff"></canvas></div>
        <div class="chart-legend">
          <div class="legend-i"><div class="legend-dot" style="background:#6366F1"></div>실매출</div>
          <div class="legend-i"><div class="legend-line" style="background:#F59E0B"></div>목표</div>
        </div>
      </div>
      <div class="chart-card">
        <div class="chart-card-title">월별 온라인 매출</div>
        <div class="chart-card-sub">실매출 vs 목표 (억원)</div>
        <div class="chart-wrap"><canvas id="chartOn"></canvas></div>
        <div class="chart-legend">
          <div class="legend-i"><div class="legend-dot" style="background:#8B5CF6"></div>실매출</div>
          <div class="legend-i"><div class="legend-line" style="background:#F59E0B"></div>목표</div>
        </div>
      </div>
    </div>

    <!-- Charts Row 2: 달성율 / 성장율 -->
    <div class="chart-grid">
      <div class="chart-card">
        <div class="chart-card-title">월별 달성율 추이</div>
        <div class="chart-card-sub">오프라인 vs 온라인 (%)</div>
        <div class="chart-wrap"><canvas id="chartAchieve"></canvas></div>
        <div class="chart-legend">
          <div class="legend-i"><div class="legend-line" style="background:#6366F1"></div>오프라인</div>
          <div class="legend-i"><div class="legend-line" style="background:#F97316"></div>온라인</div>
        </div>
      </div>
      <div class="chart-card">
        <div class="chart-card-title">전년 대비 성장율 추이</div>
        <div class="chart-card-sub">오프라인 vs 온라인 (%)</div>
        <div class="chart-wrap"><canvas id="chartGrowth"></canvas></div>
        <div class="chart-legend">
          <div class="legend-i"><div class="legend-line" style="background:#6366F1"></div>오프라인</div>
          <div class="legend-i"><div class="legend-line" style="background:#F97316"></div>온라인</div>
        </div>
      </div>
    </div>

    <!-- Chart Row 3: 채널별 비중 파이 + 월별 합계 -->
    <div class="chart-grid">
      <div class="chart-card">
        <div class="chart-card-title">채널별 매출 비중</div>
        <div class="chart-card-sub">오프라인 vs 온라인</div>
        <div class="chart-wrap"><canvas id="chartPie"></canvas></div>
      </div>
      <div class="chart-card">
        <div class="chart-card-title">월별 총 매출 추이</div>
        <div class="chart-card-sub">오프라인 + 온라인 합계 (억원)</div>
        <div class="chart-wrap"><canvas id="chartTotal"></canvas></div>
        <div class="chart-legend">
          <div class="legend-i"><div class="legend-dot" style="background:#10B981"></div>총 매출</div>
          <div class="legend-i"><div class="legend-line" style="background:#94A3B8"></div>전년</div>
        </div>
      </div>
    </div>

    <!-- Brand Section -->
    <div style="margin-top:28px; margin-bottom:16px; padding-left:4px;">
      <div style="font-size:18px; font-weight:700; color:#0F172A; letter-spacing:-0.3px;">브랜드별 매출 현황</div>
      <div style="font-size:12px; color:#94A3B8; margin-top:3px;">브랜드별 실매출 vs 목표 | 오프라인+온라인 합산 (억원)</div>
    </div>

    <!-- Brand KPI Cards -->
    <div class="kpi-row brand-kpi">
${(() => {
  const brandColors = { '아가방': '#3B82F6', '에뜨와': '#10B981', '디즈니': '#8B5CF6' };
  const brandIcons = { '아가방': '🏪', '에뜨와': '👗', '디즈니': '🏰' };
  return Object.entries(brandData).map(([brand, bd]) => {
    const salesEok = (bd.totalSales / 100000000).toFixed(1);
    const achv = bd.achieve.toFixed(1);
    const grow = bd.growth.toFixed(1);
    return `      <div class="kpi-card" style="border-left: 3px solid ${brandColors[brand]}">
        <div class="kpi-label"><span class="kpi-icon">${brandIcons[brand]}</span> ${brand}</div>
        <div class="kpi-value" style="font-size:22px;">${Number(salesEok).toLocaleString()}<span class="kpi-unit">억</span></div>
        <div class="kpi-desc">
          달성율 <span class="kpi-badge ${parseFloat(achv) >= 95 ? 'badge-green' : parseFloat(achv) >= 80 ? 'badge-blue' : 'badge-red'}">${achv}%</span>
          성장율 <span class="kpi-badge ${parseFloat(grow) >= 0 ? 'badge-green' : 'badge-red'}">${parseFloat(grow) >= 0 ? '+' : ''}${grow}%</span>
        </div>
      </div>`;
  }).join('\n');
})()}
    </div>

    <!-- Brand Charts -->
    <div class="chart-grid">
      <div class="chart-card">
        <div class="chart-card-title">브랜드별 월별 매출</div>
        <div class="chart-card-sub">실매출 합계 (억원)</div>
        <div class="chart-wrap"><canvas id="chartBrandSales"></canvas></div>
        <div class="chart-legend">
          <div class="legend-i"><div class="legend-dot" style="background:#3B82F6"></div>아가방</div>
          <div class="legend-i"><div class="legend-dot" style="background:#10B981"></div>에뜨와</div>
          <div class="legend-i"><div class="legend-dot" style="background:#8B5CF6"></div>디즈니</div>
        </div>
      </div>
      <div class="chart-card">
        <div class="chart-card-title">브랜드별 달성율 추이</div>
        <div class="chart-card-sub">목표 대비 달성율 (%)</div>
        <div class="chart-wrap"><canvas id="chartBrandAchieve"></canvas></div>
        <div class="chart-legend">
          <div class="legend-i"><div class="legend-line" style="background:#3B82F6"></div>아가방</div>
          <div class="legend-i"><div class="legend-line" style="background:#10B981"></div>에뜨와</div>
          <div class="legend-i"><div class="legend-line" style="background:#8B5CF6"></div>디즈니</div>
        </div>
      </div>
    </div>

    <div class="chart-grid">
      <div class="chart-card full">
        <div class="chart-card-title">브랜드별 매출 비중</div>
        <div class="chart-card-sub">오프라인 / 온라인 채널 분리</div>
        <div class="chart-wrap"><canvas id="chartBrandStack"></canvas></div>
        <div class="chart-legend">
          <div class="legend-i"><div class="legend-dot" style="background:#3B82F6"></div>아가방 오프</div>
          <div class="legend-i"><div class="legend-dot" style="background:#10B981"></div>에뜨와 오프</div>
          <div class="legend-i"><div class="legend-dot" style="background:#8B5CF6"></div>디즈니 오프</div>
          <div class="legend-i"><div class="legend-dot" style="background:rgba(59,130,246,0.4)"></div>아가방 온</div>
          <div class="legend-i"><div class="legend-dot" style="background:rgba(16,185,129,0.4)"></div>에뜨와 온</div>
          <div class="legend-i"><div class="legend-dot" style="background:rgba(139,92,246,0.4)"></div>디즈니 온</div>
        </div>
      </div>
    </div>

    <div class="updated">데이터 출처: Notion 온오프 목표대비 실적 DB | 갱신일: ${now}</div>
  </div>

  <script>
    Chart.register(ChartDataLabels);
    // 전역 기본값: datalabels 비활성화 (차트별로 활성화)
    Chart.defaults.plugins.datalabels = { display: false };

    const labels = ${JSON.stringify(labels)};
    // Brand data
    const brandData = ${JSON.stringify((() => {
      const result = {};
      for (const [brand, bd] of Object.entries(brandData)) {
        result[brand] = {
          labels: bd.months.map(m => m.label),
          sales: bd.months.map(m => +(m.totalSales / 100000000).toFixed(1)),
          achieve: bd.months.map(m => +m.achieve.toFixed(1)),
          offSales: bd.months.map(m => +(m.offSales / 100000000).toFixed(1)),
          onSales: bd.months.map(m => +(m.onSales / 100000000).toFixed(1)),
        };
      }
      return result;
    })())};
    const offSales = ${JSON.stringify(offSales)};
    const offTarget = ${JSON.stringify(offTarget)};
    const onSales = ${JSON.stringify(onSales)};
    const onTarget = ${JSON.stringify(onTarget)};
    const offAchieve = ${JSON.stringify(offAchieve)};
    const onAchieve = ${JSON.stringify(onAchieve)};
    const offGrowth = ${JSON.stringify(offGrowth)};
    const onGrowth = ${JSON.stringify(onGrowth)};
    const totalByMonth = offSales.map((v, i) => +(v + onSales[i]).toFixed(1));
    const prevByMonth = ${JSON.stringify(monthlyData.map(m => toEok(m.offPrev + m.onPrev)))};

    const fontFamily = "'Noto Sans KR', sans-serif";

    // 공통 datalabels 스타일 (막대 위 숫자)
    const barLabelOpts = {
      display: true,
      anchor: 'end',
      align: 'top',
      offset: 2,
      font: { family: fontFamily, size: 10, weight: '600' },
      color: '#475569',
      formatter: v => v
    };
    // 라인 차트용 (포인트 위 숫자)
    const lineLabelOpts = {
      display: true,
      anchor: 'end',
      align: 'top',
      offset: 4,
      font: { family: fontFamily, size: 9, weight: '600' },
      color: '#64748B',
      formatter: v => v + '%'
    };
    // 스택 차트용 (합계만 최상단에 표시)
    const stackTotalLabelPlugin = {
      id: 'stackTotalLabel',
      afterDatasetsDraw(chart) {
        const { ctx } = chart;
        const stacks = {};
        chart.data.datasets.forEach((ds, di) => {
          const meta = chart.getDatasetMeta(di);
          if (meta.hidden) return;
          meta.data.forEach((bar, idx) => {
            const stack = ds.stack;
            if (!stacks[stack]) stacks[stack] = {};
            if (!stacks[stack][idx]) stacks[stack][idx] = { total: 0, topY: Infinity, topX: 0 };
            const val = ds.data[idx] || 0;
            stacks[stack][idx].total += val;
            if (bar.y < stacks[stack][idx].topY) {
              stacks[stack][idx].topY = bar.y;
              stacks[stack][idx].topX = bar.x;
            }
          });
        });
        ctx.save();
        ctx.font = "600 10px 'Noto Sans KR', sans-serif";
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillStyle = '#475569';
        for (const stack of Object.values(stacks)) {
          for (const item of Object.values(stack)) {
            ctx.fillText(item.total.toFixed(1), item.topX, item.topY - 4);
          }
        }
        ctx.restore();
      }
    };
    const gridColor = '#F1F5F9';

    function tooltipCfg() {
      return {
        backgroundColor: 'rgba(15,23,42,0.92)',
        titleFont: { family: fontFamily, size: 12, weight: '600' },
        bodyFont: { family: fontFamily, size: 11 },
        padding: 10, cornerRadius: 8, boxPadding: 4
      };
    }

    // 오프라인 매출
    new Chart(document.getElementById('chartOff'), {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: '실매출', data: offSales, backgroundColor: '#6366F1', borderRadius: 5, barPercentage: 0.6, categoryPercentage: 0.7, order: 2, datalabels: barLabelOpts },
          { label: '목표', data: offTarget, type: 'line', borderColor: '#F59E0B', borderWidth: 2.5, borderDash: [5,3], pointRadius: 3, pointBackgroundColor: '#F59E0B', pointBorderColor: '#fff', pointBorderWidth: 1.5, fill: false, tension: 0.3, order: 1, datalabels: { display: false } }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        animation: { duration: 800 },
        plugins: { legend: { display: false }, tooltip: { ...tooltipCfg(), callbacks: { label: ctx => ' ' + ctx.dataset.label + ': ' + ctx.parsed.y + '억' } } },
        scales: {
          x: { grid: { display: false }, border: { display: false }, ticks: { font: { family: fontFamily, size: 10 }, color: '#94A3B8' } },
          y: { grid: { color: gridColor }, border: { display: false }, ticks: { font: { family: fontFamily, size: 10 }, color: '#CBD5E1', callback: v => v + '억' } }
        }
      }
    });

    // 온라인 매출
    new Chart(document.getElementById('chartOn'), {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: '실매출', data: onSales, backgroundColor: '#8B5CF6', borderRadius: 5, barPercentage: 0.6, categoryPercentage: 0.7, order: 2, datalabels: barLabelOpts },
          { label: '목표', data: onTarget, type: 'line', borderColor: '#F59E0B', borderWidth: 2.5, borderDash: [5,3], pointRadius: 3, pointBackgroundColor: '#F59E0B', pointBorderColor: '#fff', pointBorderWidth: 1.5, fill: false, tension: 0.3, order: 1, datalabels: { display: false } }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        animation: { duration: 800 },
        plugins: { legend: { display: false }, tooltip: { ...tooltipCfg(), callbacks: { label: ctx => ' ' + ctx.dataset.label + ': ' + ctx.parsed.y + '억' } } },
        scales: {
          x: { grid: { display: false }, border: { display: false }, ticks: { font: { family: fontFamily, size: 10 }, color: '#94A3B8' } },
          y: { grid: { color: gridColor }, border: { display: false }, ticks: { font: { family: fontFamily, size: 10 }, color: '#CBD5E1', callback: v => v + '억' } }
        }
      }
    });

    // 달성율
    new Chart(document.getElementById('chartAchieve'), {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: '오프라인', data: offAchieve, borderColor: '#6366F1', borderWidth: 2.5, pointRadius: 4, pointBackgroundColor: '#6366F1', pointBorderColor: '#fff', pointBorderWidth: 2, fill: false, tension: 0.35, datalabels: { ...lineLabelOpts, color: '#6366F1' } },
          { label: '온라인', data: onAchieve, borderColor: '#F97316', borderWidth: 2.5, pointRadius: 4, pointBackgroundColor: '#F97316', pointBorderColor: '#fff', pointBorderWidth: 2, fill: false, tension: 0.35, datalabels: { ...lineLabelOpts, color: '#F97316', align: 'bottom', anchor: 'start' } }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        animation: { duration: 800 },
        plugins: {
          legend: { display: false },
          tooltip: { ...tooltipCfg(), callbacks: { label: ctx => ' ' + ctx.dataset.label + ': ' + ctx.parsed.y + '%' } },
          annotation: { annotations: { line100: { type: 'line', yMin: 100, yMax: 100, borderColor: 'rgba(239,68,68,0.4)', borderWidth: 1.5, borderDash: [5,3], label: { display: true, content: '100%', position: 'end', font: { family: fontFamily, size: 10, weight: '600' }, color: '#EF4444', backgroundColor: 'transparent' } } } }
        },
        scales: {
          x: { grid: { display: false }, border: { display: false }, ticks: { font: { family: fontFamily, size: 10 }, color: '#94A3B8' } },
          y: { grid: { color: gridColor }, border: { display: false }, ticks: { font: { family: fontFamily, size: 10 }, color: '#CBD5E1', callback: v => v + '%' } }
        }
      }
    });

    // 성장율
    new Chart(document.getElementById('chartGrowth'), {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: '오프라인', data: offGrowth, borderColor: '#6366F1', borderWidth: 2.5, pointRadius: 4, pointBackgroundColor: '#6366F1', pointBorderColor: '#fff', pointBorderWidth: 2, fill: false, tension: 0.35, datalabels: { ...lineLabelOpts, color: '#6366F1', formatter: v => (v >= 0 ? '+' : '') + v + '%' } },
          { label: '온라인', data: onGrowth, borderColor: '#F97316', borderWidth: 2.5, pointRadius: 4, pointBackgroundColor: '#F97316', pointBorderColor: '#fff', pointBorderWidth: 2, fill: false, tension: 0.35, datalabels: { ...lineLabelOpts, color: '#F97316', align: 'bottom', anchor: 'start', formatter: v => (v >= 0 ? '+' : '') + v + '%' } }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        animation: { duration: 800 },
        plugins: {
          legend: { display: false },
          tooltip: { ...tooltipCfg(), callbacks: { label: ctx => ' ' + ctx.dataset.label + ': ' + (ctx.parsed.y >= 0 ? '+' : '') + ctx.parsed.y + '%' } },
          annotation: { annotations: { line0: { type: 'line', yMin: 0, yMax: 0, borderColor: 'rgba(107,114,128,0.3)', borderWidth: 1, borderDash: [4,3] } } }
        },
        scales: {
          x: { grid: { display: false }, border: { display: false }, ticks: { font: { family: fontFamily, size: 10 }, color: '#94A3B8' } },
          y: { grid: { color: gridColor }, border: { display: false }, ticks: { font: { family: fontFamily, size: 10 }, color: '#CBD5E1', callback: v => v + '%' } }
        }
      }
    });

    // 채널별 비중 파이
    const pieCenterPlugin = {
      id: 'pieCenter',
      afterDraw(chart) {
        const { ctx, chartArea: { width, height, top, left } } = chart;
        const cx = left + width / 2, cy = top + height / 2;
        ctx.save();
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.font = "700 22px 'Noto Sans KR', sans-serif";
        ctx.fillStyle = '#0F172A';
        ctx.fillText('${totalSales}', cx, cy - 8);
        ctx.font = "400 12px 'Noto Sans KR', sans-serif";
        ctx.fillStyle = '#94A3B8';
        ctx.fillText('억원', cx, cy + 14);
        ctx.restore();
      }
    };
    new Chart(document.getElementById('chartPie'), {
      type: 'doughnut',
      data: {
        labels: ['오프라인', '온라인'],
        datasets: [{ data: [${totalOffSales}, ${totalOnSales}], backgroundColor: ['#6366F1', '#F97316'], borderColor: '#fff', borderWidth: 3, hoverOffset: 6 }]
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '65%',
        plugins: {
          legend: { position: 'bottom', labels: { font: { family: fontFamily, size: 12, weight: '500' }, color: '#64748B', usePointStyle: true, pointStyle: 'circle', padding: 16,
            generateLabels: function(chart) {
              const ds = chart.data.datasets[0];
              const total = ds.data.reduce((a,b) => a+b, 0);
              return chart.data.labels.map((l, i) => ({ text: l + ' ' + (ds.data[i] / total * 100).toFixed(1) + '%', fillStyle: ds.backgroundColor[i], strokeStyle: ds.backgroundColor[i], index: i, pointStyle: 'circle' }));
            }
          } },
          tooltip: { ...tooltipCfg(), callbacks: { label: ctx => ' ' + ctx.label + ': ' + ctx.parsed + '억 (' + (ctx.parsed / (${totalSales}) * 100).toFixed(1) + '%)' } }
        }
      },
      plugins: [pieCenterPlugin]
    });

    // 월별 총 매출
    new Chart(document.getElementById('chartTotal'), {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: '총 매출', data: totalByMonth, backgroundColor: '#10B981', borderRadius: 5, barPercentage: 0.6, categoryPercentage: 0.7, order: 2, datalabels: barLabelOpts },
          { label: '전년', data: prevByMonth, type: 'line', borderColor: '#94A3B8', borderWidth: 2, borderDash: [5,3], pointRadius: 3, pointBackgroundColor: '#94A3B8', pointBorderColor: '#fff', pointBorderWidth: 1.5, fill: false, tension: 0.3, order: 1, datalabels: { display: false } }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        animation: { duration: 800 },
        plugins: { legend: { display: false }, tooltip: { ...tooltipCfg(), callbacks: { label: ctx => ' ' + ctx.dataset.label + ': ' + ctx.parsed.y + '억' } } },
        scales: {
          x: { grid: { display: false }, border: { display: false }, ticks: { font: { family: fontFamily, size: 10 }, color: '#94A3B8' } },
          y: { grid: { color: gridColor }, border: { display: false }, ticks: { font: { family: fontFamily, size: 10 }, color: '#CBD5E1', callback: v => v + '억' } }
        }
      }
    });
    // 브랜드별 월별 매출 (그룹 바 차트)
    new Chart(document.getElementById('chartBrandSales'), {
      type: 'bar',
      data: {
        labels: brandData['아가방'].labels,
        datasets: [
          { label: '아가방', data: brandData['아가방'].sales, backgroundColor: '#3B82F6', borderRadius: 5, barPercentage: 0.7, categoryPercentage: 0.75, datalabels: { ...barLabelOpts, color: '#3B82F6' } },
          { label: '에뜨와', data: brandData['에뜨와'].sales, backgroundColor: '#10B981', borderRadius: 5, barPercentage: 0.7, categoryPercentage: 0.75, datalabels: { ...barLabelOpts, color: '#059669' } },
          { label: '디즈니', data: brandData['디즈니'].sales, backgroundColor: '#8B5CF6', borderRadius: 5, barPercentage: 0.7, categoryPercentage: 0.75, datalabels: { ...barLabelOpts, color: '#7C3AED' } }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        animation: { duration: 800 },
        plugins: { legend: { display: false }, tooltip: { ...tooltipCfg(), callbacks: { label: ctx => ' ' + ctx.dataset.label + ': ' + ctx.parsed.y + '억' } } },
        scales: {
          x: { grid: { display: false }, border: { display: false }, ticks: { font: { family: fontFamily, size: 10 }, color: '#94A3B8' } },
          y: { grid: { color: gridColor }, border: { display: false }, ticks: { font: { family: fontFamily, size: 10 }, color: '#CBD5E1', callback: v => v + '억' } }
        }
      }
    });

    // 브랜드별 달성율 (라인 차트)
    new Chart(document.getElementById('chartBrandAchieve'), {
      type: 'line',
      data: {
        labels: brandData['아가방'].labels,
        datasets: [
          { label: '아가방', data: brandData['아가방'].achieve, borderColor: '#3B82F6', borderWidth: 2.5, pointRadius: 5, pointBackgroundColor: '#3B82F6', pointBorderColor: '#fff', pointBorderWidth: 2, fill: false, tension: 0.35, datalabels: { ...lineLabelOpts, color: '#3B82F6' } },
          { label: '에뜨와', data: brandData['에뜨와'].achieve, borderColor: '#10B981', borderWidth: 2.5, pointRadius: 5, pointBackgroundColor: '#10B981', pointBorderColor: '#fff', pointBorderWidth: 2, fill: false, tension: 0.35, datalabels: { ...lineLabelOpts, color: '#059669', align: 'bottom', anchor: 'start' } },
          { label: '디즈니', data: brandData['디즈니'].achieve, borderColor: '#8B5CF6', borderWidth: 2.5, pointRadius: 5, pointBackgroundColor: '#8B5CF6', pointBorderColor: '#fff', pointBorderWidth: 2, fill: false, tension: 0.35, datalabels: { ...lineLabelOpts, color: '#7C3AED' } }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        animation: { duration: 800 },
        plugins: {
          legend: { display: false },
          tooltip: { ...tooltipCfg(), callbacks: { label: ctx => ' ' + ctx.dataset.label + ': ' + ctx.parsed.y + '%' } },
          annotation: { annotations: { line100: { type: 'line', yMin: 100, yMax: 100, borderColor: 'rgba(239,68,68,0.4)', borderWidth: 1.5, borderDash: [5,3] } } }
        },
        scales: {
          x: { grid: { display: false }, border: { display: false }, ticks: { font: { family: fontFamily, size: 10 }, color: '#94A3B8' } },
          y: { grid: { color: gridColor }, border: { display: false }, ticks: { font: { family: fontFamily, size: 10 }, color: '#CBD5E1', callback: v => v + '%' } }
        }
      }
    });

    // 브랜드별 스택 바 (오프/온 분리)
    new Chart(document.getElementById('chartBrandStack'), {
      type: 'bar',
      data: {
        labels: brandData['아가방'].labels,
        datasets: [
          { label: '아가방 온', data: brandData['아가방'].onSales, backgroundColor: 'rgba(59,130,246,0.4)', stack: 'ag', borderRadius: 0, barPercentage: 0.65, categoryPercentage: 0.75 },
          { label: '아가방 오프', data: brandData['아가방'].offSales, backgroundColor: '#3B82F6', stack: 'ag', borderRadius: 4, barPercentage: 0.65, categoryPercentage: 0.75 },
          { label: '에뜨와 온', data: brandData['에뜨와'].onSales, backgroundColor: 'rgba(16,185,129,0.4)', stack: 'et', borderRadius: 0, barPercentage: 0.65, categoryPercentage: 0.75 },
          { label: '에뜨와 오프', data: brandData['에뜨와'].offSales, backgroundColor: '#10B981', stack: 'et', borderRadius: 4, barPercentage: 0.65, categoryPercentage: 0.75 },
          { label: '디즈니 온', data: brandData['디즈니'].onSales, backgroundColor: 'rgba(139,92,246,0.4)', stack: 'dn', borderRadius: 0, barPercentage: 0.65, categoryPercentage: 0.75 },
          { label: '디즈니 오프', data: brandData['디즈니'].offSales, backgroundColor: '#8B5CF6', stack: 'dn', borderRadius: 4, barPercentage: 0.65, categoryPercentage: 0.75 }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        animation: { duration: 800 },
        plugins: { legend: { display: false }, datalabels: { display: false }, tooltip: { ...tooltipCfg(), callbacks: { label: ctx => ' ' + ctx.dataset.label + ': ' + ctx.parsed.y + '억' } } },
        scales: {
          x: { stacked: true, grid: { display: false }, border: { display: false }, ticks: { font: { family: fontFamily, size: 10 }, color: '#94A3B8' } },
          y: { stacked: true, grid: { color: gridColor }, border: { display: false }, ticks: { font: { family: fontFamily, size: 10 }, color: '#CBD5E1', callback: v => v + '억' } }
        }
      },
      plugins: [stackTotalLabelPlugin]
    });
  </script>
</body>
</html>`;
}

// ── 메인 실행 ──
async function main() {
  console.log('=== Notion DB → 차트 자동 생성 스크립트 ===');
  console.log(`실행 시각: ${new Date().toISOString()}`);

  // ━━━ Part A: 월별 매출 현황(DB) → 사업부별 차트 ━━━
  console.log('\n── Part A: 월별 매출 현황(DB) ──');
  console.log('[A-1] Notion DB 조회 중...');
  const filter = {
    property: '연도',
    select: { equals: '2026' }
  };
  const records2026 = await notionQuery(NOTION_DB_ID, filter);
  console.log(`  → 2026년 데이터 ${records2026.length}건 조회`);

  const allRecords = records2026.map(extractProps);

  console.log('[A-2] 데이터 집계 중...');
  const divisions = aggregateData(allRecords);
  for (const [name, d] of Object.entries(divisions)) {
    const rate = d.targetSales > 0 ? (d.actualSales / d.targetSales * 100).toFixed(1) : '-';
    console.log(`  ${name}: 실적=${Math.round(d.actualSales/1000000)}백만, 달성율=${rate}%`);
  }

  console.log('[A-3] 차트 생성...');
  const yoyHtml = generateYoYChart(divisions);
  fs.writeFileSync(path.join(OUTPUT_DIR, 'yoy-performance.html'), yoyHtml, 'utf8');
  console.log('  ✓ yoy-performance.html');

  const planHtml = generatePlanChart(divisions);
  fs.writeFileSync(path.join(OUTPUT_DIR, 'plan-achievement.html'), planHtml, 'utf8');
  console.log('  ✓ plan-achievement.html');

  // ━━━ Part B: 온오프 목표대비 실적 DB → 온오프 대시보드 ━━━
  console.log('\n── Part B: 온오프 목표대비 실적 DB ──');
  console.log('[B-1] Notion DB 조회 중...');

  // 현재 연도 판단 (2026)
  const currentYear = new Date().getFullYear();
  const yearPrefix = String(currentYear);

  const onoffRecords = await notionQuery(ONOFF_DB_ID);
  console.log(`  → 전체 ${onoffRecords.length}건 조회`);

  const onoffData = onoffRecords.map(extractOnoffProps);
  const currentYearData = onoffData.filter(r => r.년월.startsWith(yearPrefix));
  console.log(`  → ${currentYear}년 데이터 ${currentYearData.length}건`);

  console.log('[B-2] 월별 집계 중...');
  const monthlyData = aggregateOnoffByMonth(onoffData, currentYear);
  console.log(`  → ${monthlyData.length}개월 데이터`);
  monthlyData.forEach(m => {
    console.log(`  ${m.label}: OFF ${(m.offSales/100000000).toFixed(1)}억 (${m.offAchieve.toFixed(1)}%) / ON ${(m.onSales/100000000).toFixed(1)}억 (${m.onAchieve.toFixed(1)}%)`);
  });

  console.log('[B-3] 브랜드별 집계 중...');
  const brandData = aggregateOnoffByBrand(onoffData, currentYear);
  for (const [brand, bd] of Object.entries(brandData)) {
    console.log(`  ${brand}: ${(bd.totalSales/100000000).toFixed(1)}억 (달성율 ${bd.achieve.toFixed(1)}%, 성장율 ${bd.growth >= 0 ? '+' : ''}${bd.growth.toFixed(1)}%)`);
  }

  console.log('[B-4] 대시보드 차트 생성...');
  const dashHtml = generateOnoffDashboard(monthlyData, currentYear, brandData);
  fs.writeFileSync(path.join(OUTPUT_DIR, 'onoff-dashboard.html'), dashHtml, 'utf8');
  console.log('  ✓ onoff-dashboard.html');

  // ━━━ Git Push ━━━
  console.log('\n── Git Push ──');
  gitAutoPush();

  console.log('\n=== 완료 ===');
}

main().catch(err => {
  console.error('오류 발생:', err);
  process.exit(1);
});
