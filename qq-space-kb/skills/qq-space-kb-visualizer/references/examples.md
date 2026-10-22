# 示例：年份分布看板

下面是配方 A 的**完整可运行样例**。数据是合成的，只用于说明字段形状与图表基数，
不代表任何真实账号。

写新组件时照这个骨架改：**信封顺序固定**（meta → style → html → data → script → fallback）、
**数据只从 `window.__mavisData` 读**、**主题色只走 `--mw-*` 与 `window.mavisTheme.tokens`**。

```html
<mavis-widget
  version="mavis.widget.v1"
  kind="dashboard"
  title="QQ 空间说说知识库 · 年份分布"
  height="720"
  min-height="560"
  max-height="1000"
  streaming="html-first"
  capabilities="resize,sendPrompt"
  theme="app"
  token-set="mavis.semantic.v1">
  <mavis-meta type="json">{"summary":"8 个年份、26 条说说；2017 年最密，回溯记录集中在 2014–2018 年，其中 5 条只剩发布时间与互动痕迹。","dataSource":"MCP 工具 kb_stats 的 yearDistribution（本地 QQ 空间知识库的确定性统计，本例为合成样例数据）","chartType":"bar","datasetShape":{"rows":8,"dimensions":["year"],"measures":["count","recovered","bodyMissing"]},"interactions":[{"id":"drill-year","label":"列出该年份的说说","capability":"sendPrompt"},{"id":"densest-year","label":"哪一年最密","capability":"sendPrompt"},{"id":"recovered-years","label":"回溯集中在哪几年","capability":"sendPrompt"}]}</mavis-meta>
  <mavis-style>
    body{margin:0;padding:16px;background:var(--mw-bg);color:var(--mw-text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5}
    .kpi-row{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:14px}
    .kpi{background:var(--mw-surface);border:1px solid var(--mw-border);border-radius:10px;padding:13px 14px}
    .kpi-label{font-size:12px;color:var(--mw-text-muted);margin-bottom:3px}
    .kpi-value{font-size:24px;font-weight:700;color:var(--mw-text)}
    .kpi-sub{font-size:12px;color:var(--mw-text-subtle);margin-top:3px}
    .card{background:var(--mw-surface);border:1px solid var(--mw-border);border-radius:10px;padding:15px 16px;margin-bottom:14px}
    .card-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:10px}
    .card-title{font-size:14px;font-weight:500;color:var(--mw-text)}
    .card-note{font-size:12px;color:var(--mw-text-muted)}
    .legend{display:flex;flex-wrap:wrap;gap:14px;font-size:12px;color:var(--mw-text-muted)}
    .legend-item{display:flex;align-items:center;gap:6px}
    .legend-dot{width:10px;height:10px;border-radius:3px}
    .chart-wrap{position:relative;width:100%;height:280px}
    table{width:100%;border-collapse:collapse}
    th{padding:8px 10px;text-align:left;font-size:12px;font-weight:500;color:var(--mw-text-muted);background:var(--mw-surface-muted);border-bottom:1px solid var(--mw-border)}
    th.num{text-align:right}
    td{padding:8px 10px;border-bottom:1px solid var(--mw-border);font-size:13px}
    td.num{text-align:right;font-variant-numeric:tabular-nums}
    tbody tr{cursor:pointer;transition:background 0.15s}
    tbody tr:hover{background:var(--mw-surface-muted)}
    tbody tr:focus-visible{outline:2px solid var(--mw-accent);outline-offset:-2px}
    .tag{display:inline-block;font-size:11px;border:1px solid var(--mw-border);border-radius:5px;padding:1px 6px;color:var(--mw-text-muted)}
    .action-bar{display:flex;gap:8px;flex-wrap:wrap;padding-top:12px;border-top:1px solid var(--mw-border)}
    .action-btn{padding:7px 13px;border-radius:8px;border:1px solid var(--mw-border);background:var(--mw-surface);color:var(--mw-text-muted);font-size:12px;cursor:pointer;font-family:inherit;transition:background 0.15s}
    .action-btn:hover{background:var(--mw-surface-muted);color:var(--mw-accent);border-color:var(--mw-accent)}
    .action-btn:focus-visible{outline:2px solid var(--mw-accent);outline-offset:2px}
    .empty{padding:40px 12px;text-align:center;color:var(--mw-text-muted);font-size:13px}
  </mavis-style>
  <mavis-html>
    <div class="kpi-row">
      <div class="kpi"><div class="kpi-label">说说总数</div><div class="kpi-value" id="kpi-total">—</div><div class="kpi-sub" id="kpi-total-sub">条</div></div>
      <div class="kpi"><div class="kpi-label">覆盖年份</div><div class="kpi-value" id="kpi-years">—</div><div class="kpi-sub" id="kpi-years-sub">年</div></div>
      <div class="kpi"><div class="kpi-label">已删除后恢复</div><div class="kpi-value" id="kpi-recovered">—</div><div class="kpi-sub" id="kpi-recovered-sub">条</div></div>
      <div class="kpi"><div class="kpi-label">正文未能恢复</div><div class="kpi-value" id="kpi-missing">—</div><div class="kpi-sub" id="kpi-missing-sub">条</div></div>
    </div>

    <div class="card">
      <div class="card-head">
        <div>
          <div class="card-title">逐年构成</div>
          <div class="card-note" id="chart-note">按年统计，每段表示一条说说来自哪里</div>
        </div>
        <div class="legend">
          <span class="legend-item"><span class="legend-dot" style="background:var(--mw-chart-1)"></span>现存有正文</span>
          <span class="legend-item"><span class="legend-dot" style="background:var(--mw-chart-2)"></span>回溯有正文</span>
          <span class="legend-item"><span class="legend-dot" style="background:var(--mw-chart-3)"></span>回溯无正文</span>
        </div>
      </div>
      <div class="chart-wrap"><canvas id="year-chart"></canvas></div>
    </div>

    <div class="card">
      <div class="card-head">
        <div class="card-title">按年份明细</div>
        <div class="card-note">点某一行，问候那一年</div>
      </div>
      <table>
        <thead><tr><th>年份</th><th class="num">条数</th><th class="num">回溯</th><th class="num">正文缺失</th><th>构成</th></tr></thead>
        <tbody id="year-rows"></tbody>
      </table>
    </div>

    <div class="card">
      <div class="card-title" style="margin-bottom:10px">继续问</div>
      <div class="action-bar">
        <button class="action-btn" data-action="densest-year">哪一年最密</button>
        <button class="action-btn" data-action="recovered-years">回溯集中在哪几年</button>
      </div>
    </div>
  </mavis-html>
  <mavis-data name="main" type="json">[{"year":"2013","count":2,"recovered":0,"bodyMissing":0,"withBody":2},{"year":"2014","count":3,"recovered":1,"bodyMissing":1,"withBody":2},{"year":"2015","count":5,"recovered":2,"bodyMissing":1,"withBody":4},{"year":"2016","count":4,"recovered":1,"bodyMissing":1,"withBody":3},{"year":"2017","count":6,"recovered":3,"bodyMissing":2,"withBody":4},{"year":"2018","count":3,"recovered":1,"bodyMissing":0,"withBody":3},{"year":"2019","count":2,"recovered":0,"bodyMissing":0,"withBody":2},{"year":"2020","count":1,"recovered":0,"bodyMissing":0,"withBody":1}]</mavis-data>
  <mavis-script>
    (function () {
      var rows = window.__mavisData['main'] || [];
      var t = window.mavisTheme.tokens;
      var fmt = new Intl.NumberFormat('zh-CN');

      function setText(id, value) { var el = document.getElementById(id); if (el) el.textContent = value; }

      if (!rows.length) {
        document.querySelector('.kpi-row').innerHTML = '';
        var note = document.getElementById('chart-note');
        if (note) note.textContent = '知识库还没有数据，先导出说说并建库';
        var wrap = document.querySelector('.chart-wrap');
        if (wrap) wrap.innerHTML = '<div class="empty">知识库还没有数据，先导出说说并建库</div>';
        return;
      }

      var total = rows.reduce(function (s, r) { return s + r.count; }, 0);
      var recovered = rows.reduce(function (s, r) { return s + r.recovered; }, 0);
      var missing = rows.reduce(function (s, r) { return s + r.bodyMissing; }, 0);
      var years = rows.map(function (r) { return r.year; });
      var densest = rows.reduce(function (a, b) { return b.count > a.count ? b : a; });

      setText('kpi-total', fmt.format(total));
      setText('kpi-total-sub', '条，含回溯找回的');
      setText('kpi-years', String(years.length));
      setText('kpi-years-sub', years[0] + '–' + years[years.length - 1]);
      setText('kpi-recovered', fmt.format(recovered));
      setText('kpi-recovered-sub', '条，占 ' + (total ? Math.round((recovered / total) * 100) : 0) + '%');
      setText('kpi-missing', fmt.format(missing));
      setText('kpi-missing-sub', '条只剩时间与互动痕迹');

      var tbody = document.getElementById('year-rows');
      rows.forEach(function (r) {
        var tr = document.createElement('tr');
        tr.setAttribute('data-action', 'drill-year');
        tr.setAttribute('data-year', r.year);
        tr.setAttribute('tabindex', '0');
        var parts = [];
        if (r.count - r.recovered > 0) parts.push('现存 ' + (r.count - r.recovered));
        if (r.recovered - r.bodyMissing > 0) parts.push('回溯有正文 ' + (r.recovered - r.bodyMissing));
        if (r.bodyMissing > 0) parts.push('回溯无正文 ' + r.bodyMissing);
        tr.innerHTML = '<td>' + r.year + '</td><td class="num">' + r.count + '</td><td class="num">' + r.recovered + '</td><td class="num">' + r.bodyMissing + '</td><td><span class="tag">' + parts.join(' · ') + '</span></td>';
        tbody.appendChild(tr);
      });

      var labels = rows.map(function (r) { return r.year; });
      var existing = rows.map(function (r) { return r.count - r.recovered; });
      var recWith = rows.map(function (r) { return r.recovered - r.bodyMissing; });
      var recNo = rows.map(function (r) { return r.bodyMissing; });

      var chart = new Chart(document.getElementById('year-chart'), {
        type: 'bar',
        data: {
          labels: labels,
          datasets: [
            { label: '现存有正文', data: existing, backgroundColor: t.chart1, borderRadius: 4, borderSkipped: false },
            { label: '回溯有正文', data: recWith, backgroundColor: t.chart2, borderRadius: 4, borderSkipped: false },
            { label: '回溯无正文', data: recNo, backgroundColor: t.chart3, borderRadius: 4, borderSkipped: false }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: { duration: 600, easing: 'easeOutQuart' },
          onClick: function (evt, elements) {
            if (!elements.length) return;
            var row = rows[elements[0].index];
            if (row) askYear(row);
          },
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: t.surface,
              titleColor: t.text,
              bodyColor: t.textMuted,
              borderColor: t.border,
              borderWidth: 1,
              callbacks: {
                afterBody: function (items) {
                  var row = rows[items[0].dataIndex];
                  if (!row) return '';
                  return '共 ' + row.count + ' 条 · 回溯 ' + row.recovered + ' 条 · 正文缺失 ' + row.bodyMissing + ' 条';
                }
              }
            }
          },
          scales: {
            x: { stacked: true, grid: { display: false }, ticks: { color: t.chartAxis, autoSkip: false, maxRotation: 0 } },
            y: { stacked: true, beginAtZero: true, grid: { color: t.chartGrid }, ticks: { color: t.chartAxis, precision: 0 } }
          }
        }
      });

      function askYear(row) {
        if (!window.mavis || typeof window.mavis.sendPrompt !== 'function') return;
        window.mavis.sendPrompt('列出 ' + row.year + ' 年我发过的说说。', {
          widgetTitle: 'QQ 空间说说知识库 · 年份分布',
          action: 'drill-year',
          selectedData: { year: row.year, count: row.count, recovered: row.recovered, bodyMissing: row.bodyMissing, withBody: row.withBody },
          visibleFilters: { year: row.year },
          userIntent: '列出该年份的全部说说'
        });
      }

      document.querySelectorAll('tr[data-action="drill-year"]').forEach(function (tr) {
        var fire = function () {
          var row = rows.find(function (r) { return r.year === tr.getAttribute('data-year'); });
          if (row) askYear(row);
        };
        tr.addEventListener('click', fire);
        tr.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fire(); }
        });
      });

      var actions = {
        'densest-year': {
          text: '我的说说在哪一年最密集？那一年大概在忙什么？',
          intent: '分析数据最密集的年份'
        },
        'recovered-years': {
          text: '我删掉又捞回来的说说集中在哪几年？说明什么？',
          intent: '分析回溯记录的年份分布'
        }
      };

      document.querySelectorAll('.action-btn[data-action]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var info = actions[btn.getAttribute('data-action')];
          if (!info || !window.mavis || typeof window.mavis.sendPrompt !== 'function') return;
          var payload = btn.getAttribute('data-action') === 'densest-year'
            ? { year: densest.year, count: densest.count, recovered: densest.recovered, bodyMissing: densest.bodyMissing, withBody: densest.withBody }
            : { years: labels.slice(), recoveredTotal: recovered, totalRecords: total };
          window.mavis.sendPrompt(info.text, {
            widgetTitle: 'QQ 空间说说知识库 · 年份分布',
            action: btn.getAttribute('data-action'),
            selectedData: payload,
            visibleFilters: { yearFrom: years[0], yearTo: years[years.length - 1] },
            userIntent: info.intent
          });
        });
      });

      window.addEventListener('mavis:theme-change', function () {
        var nt = window.mavisTheme.tokens;
        var ramp = [nt.chart1, nt.chart2, nt.chart3];
        chart.data.datasets.forEach(function (ds, i) { ds.backgroundColor = ramp[i]; });
        chart.options.scales.x.ticks.color = nt.chartAxis;
        chart.options.scales.y.ticks.color = nt.chartAxis;
        chart.options.scales.y.grid.color = nt.chartGrid;
        chart.options.plugins.tooltip.backgroundColor = nt.surface;
        chart.options.plugins.tooltip.titleColor = nt.text;
        chart.options.plugins.tooltip.bodyColor = nt.textMuted;
        chart.options.plugins.tooltip.borderColor = nt.border;
        chart.update('none');
      });
    })();
  </mavis-script>
  <mavis-fallback>
8 个年份、26 条说说。2017 年最密（6 条），回溯记录集中在 2014–2018 年（8 条全部落在窗口内）。其中 5 条只剩发布时间与互动痕迹，正文没能恢复。

| 年份 | 条数 | 回溯 | 正文缺失 |
|---|---|---|---|
| 2015 | 5 | 2 | 1 |
| 2016 | 4 | 1 | 1 |
| 2017 | 6 | 3 | 2 |
| 2018 | 3 | 1 | 0 |
| 2014 | 3 | 1 | 1 |

趋势：条数从 2013 年的 2 条缓慢上升，在 2017 年见顶，2019 年后迅速回落。
  </mavis-fallback>
</mavis-widget>
```

## 这个样例守住的几条

| 规则 | 体现在哪 |
|---|---|
| 数据只从 `window.__mavisData` 读 | 脚本第一行取 `main`，表格、KPI、图表全部由它渲染，没有第二份数据 |
| 6 个以上同类数据点用 Chart.js | 8 个年份 → 堆叠柱图，`<canvas>` 包在 `.chart-wrap`（显式 280px 高）里 |
| 主题色只走 token | CSS 用 `var(--mw-*)`，Chart.js 配色读 `window.mavisTheme.tokens`，并监听 `mavis:theme-change` 重建 |
| 三个派生序列在前端算 | 现有有正文 / 回溯有正文 / 回溯无正文 由 `count`/`recovered`/`bodyMissing` 推出，不另存一份 |
| 追问载荷只带稳定标识 | `selectedData` 只有 `year` 与该年的四个数，不含 QQ 号、路径、报错 |
| 追问语言跟对话一致 | `text` 与 `userIntent` 全中文 |
| 交互不滥用 | 排序/悬停留在本地；只有「点某年」「两个行动按钮」三处发消息 |
| 空态不渲染追问 | `rows` 为空时提前返回，图例区给出说明，不发任何消息 |
| 兜底有结论也有数据 | `<mavis-fallback>` 给一句结论 + 5 行明细 + 趋势方向 |
