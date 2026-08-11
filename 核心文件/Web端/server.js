const fs = require('fs');
const path = require('path');
const http = require('http');
const { setTimeout: sleep } = require('timers/promises');
const { loadEnv } = require('../load_env');

// ========== 配置初始化 ==========
loadEnv(path.join(__dirname, '..', '..', '.env'));

const appkey = process.env.DINGTALK_APPKEY;
const appsecret = process.env.DINGTALK_APPSECRET;
if (!appkey || !appsecret) {
    console.error('错误：未设置 DINGTALK_APPKEY / DINGTALK_APPSECRET 环境变量');
    process.exit(1);
}

const config = require('../config.json');
const outputPath = config.outputPath || path.join(__dirname, '..');

// ========== 常量 ==========
const PORT = 3000;
const RETRY_DELAY_MS = 1000;
const BATCH_THROTTLE_MS = 100;
const PAGE_SIZE = 100;
const CONCURRENCY = 3;
const RE_ALNUM = /[a-zA-Z0-9]+/g;
const RE_DQUOTE = /"/g;

// Token 缓存
let cachedToken = null;
let tokenExpiresAt = 0;
let tokenPromise = null;

// ========== 工具函数 ==========
const pad2 = n => String(n).padStart(2, '0');

function normalizeRemark(remark) {
    return (remark?.match(RE_ALNUM) || []).join(',');
}

function csvEscape(val) {
    const s = String(val ?? '');
    return s.includes('"') ? s.replace(RE_DQUOTE, '""') : s;
}

function formatTimestamp(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

async function httpGet(url, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } catch (e) {
            if (i === retries - 1) throw e;
            await sleep(RETRY_DELAY_MS);
        }
    }
}

// ========== Token 管理 ==========
async function getToken() {
    if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;
    if (tokenPromise) return tokenPromise; // 合并并发请求
    tokenPromise = (async () => {
        try {
            console.log('获取新 token...');
            const res = await httpGet(`https://oapi.dingtalk.com/gettoken?appkey=${appkey}&appsecret=${appsecret}`);
            if (!res.access_token) throw new Error(`获取 token 失败: ${JSON.stringify(res)}`);
            cachedToken = res.access_token;
            tokenExpiresAt = Date.now() + (res.expires_in || 7200) * 1000 - 60000;
            console.log('Token:', cachedToken.substring(0, 10) + '...');
            return cachedToken;
        } finally {
            tokenPromise = null;
        }
    })();
    return tokenPromise;
}

// ========== 拉取签到记录 ==========
async function fetchAllRecords(token, departmentId, startTime, endTime) {
    const allData = [];
    const urlBase = `https://oapi.dingtalk.com/checkin/record?access_token=${token}&department_id=${departmentId}&start_time=${startTime}&end_time=${endTime}&size=${PAGE_SIZE}&order=desc`;

    async function loadPage(offset) {
        const json = await httpGet(`${urlBase}&offset=${offset}`);
        if (json.errcode !== 0) throw new Error(json.errmsg);
        return { count: json.data?.length || 0, records: json.data || [] };
    }

    const first = await loadPage(0);
    allData.push(...first.records);

    if (first.count >= PAGE_SIZE) {
        let batchOffset = PAGE_SIZE;
        outer:
        while (true) {
            const offsets = Array.from({ length: CONCURRENCY }, (_, i) => batchOffset + i * PAGE_SIZE);
            const results = await Promise.all(offsets.map(o => loadPage(o)));
            for (let i = 0; i < results.length; i++) {
                const r = results[i];
                allData.push(...r.records);
                if (r.count < PAGE_SIZE) break outer;
            }
            batchOffset += CONCURRENCY * PAGE_SIZE;
            await sleep(BATCH_THROTTLE_MS);
        }
    }
    return allData;
}

// ========== CSV 生成 ==========
function generateCSV(data, startYear, startMonth, endYear, endMonth, deptName) {
    data.sort((a, b) => a.timestamp - b.timestamp);
    let maxImages = 0;
    for (const r of data) {
        const len = (r.imageList || []).length;
        if (len > maxImages) maxImages = len;
    }
    const imageHeaders = Array.from({ length: maxImages }, (_, i) => `,图${i + 1}`).join('');
    const header = `序号,姓名,签到时间,签到地点,详细地址,纬度,经度,备注${imageHeaders}`;
    const csvLines = [header];

    data.forEach((record, index) => {
        const baseCols = [
            index + 1, csvEscape(record.name), formatTimestamp(record.timestamp),
            csvEscape(record.place), csvEscape(record.detailPlace),
            record.latitude ?? '', record.longitude ?? '', normalizeRemark(record.remark),
        ];
        const imageCols = (record.imageList || []).map(csvEscape);
        while (imageCols.length < maxImages) imageCols.push('');
        csvLines.push('"' + [...baseCols, ...imageCols].join('","') + '"');
    });

    const BOM = '﻿';
    const csv = BOM + csvLines.join('\n') + '\n';

    const dateStr = startYear === endYear && startMonth === endMonth
        ? `${startYear}_${pad2(startMonth)}`
        : `${startYear}_${pad2(startMonth)}-${pad2(endMonth)}`;
    const safeName = deptName.replace(/[\\/:*?"<>|]/g, '_');
    const filename = `签到${dateStr}_${safeName}.csv`;
    return { csv, filename };
}

// ========== HTTP 请求体解析 ==========
function parseBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
            catch (_) { resolve({}); }
        });
        req.on('error', reject);
    });
}

// ========== 路由处理 ==========
const PAGE_HTML = getHTML();

function sendJSON(res, data, status = 200) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
}

function sendError(res, msg, status = 500) {
    sendJSON(res, { error: msg }, status);
}

async function handleRequest(req, res) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const method = req.method;

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    try {
        // GET / — 前端页面
        if (method === 'GET' && url.pathname === '/') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(PAGE_HTML);
            return;
        }

        // GET /api/depts — 获取部门列表
        if (method === 'GET' && url.pathname === '/api/depts') {
            const token = await getToken();
            const result = await httpGet(`https://oapi.dingtalk.com/department/list?access_token=${token}`);
            if (result.errcode !== 0 || !result.department) {
                sendError(res, '获取部门列表失败: ' + (result.errmsg || '未知错误'));
                return;
            }
            const depts = [...result.department].sort((a, b) => a.id - b.id);
            sendJSON(res, { depts: depts.map(d => ({ id: d.id, name: d.name })) });
            return;
        }

        // POST /api/preview — 预览签到记录
        if (method === 'POST' && url.pathname === '/api/preview') {
            const { deptId, startTime, endTime } = await parseBody(req);
            if (!deptId || !startTime || !endTime) {
                sendError(res, '缺少参数: deptId, startTime, endTime', 400);
                return;
            }
            const token = await getToken();
            const data = await fetchAllRecords(token, deptId, startTime, endTime);
            sendJSON(res, { total: data.length, preview: data.slice(0, 10) });
            return;
        }

        // POST /api/export — 导出 CSV
        if (method === 'POST' && url.pathname === '/api/export') {
            const { deptId, startTime, endTime, deptName, startYear, startMonth, endYear, endMonth } = await parseBody(req);
            if (!deptId || !startTime || !endTime) {
                sendError(res, '缺少参数: deptId, startTime, endTime', 400);
                return;
            }
            const token = await getToken();
            const data = await fetchAllRecords(token, deptId, startTime, endTime);
            if (data.length === 0) {
                sendError(res, '没有签到数据', 404);
                return;
            }
            const { csv, filename } = generateCSV(data, startYear, startMonth, endYear, endMonth, deptName || '未命名');
            // 异步保存到本地（不阻塞响应）
            const csvPath = path.join(outputPath, filename);
            fs.promises.writeFile(csvPath, csv, 'utf8').catch(e => console.error('保存 CSV 失败:', e.message));
            console.log(`CSV 已保存: ${csvPath} (${data.length} 条)`);
            // 返回 CSV（前端触发下载）
            res.writeHead(200, {
                'Content-Type': 'text/csv; charset=utf-8',
                'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
            });
            res.end(csv);
            return;
        }

        // POST /api/shutdown — 关闭服务器
        if (method === 'POST' && url.pathname === '/api/shutdown') {
            sendJSON(res, { ok: true, msg: '服务器已关闭' });
            setTimeout(() => { server.close(() => process.exit(0)); }, 100);
            return;
        }

        // 404
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not Found');
    } catch (e) {
        console.error('请求处理错误:', e);
        sendError(res, e.message);
    }
}

// ========== 启动服务器 ==========
const server = http.createServer(handleRequest);
server.listen(PORT, () => {
    const url = `http://localhost:${PORT}`;
    console.log(`\n========================================`);
    console.log(`  钉钉签到导出工具已启动`);
    console.log(`  打开浏览器访问: ${url}`);
    console.log(`========================================\n`);
    // 自动打开浏览器
    const { exec } = require('child_process');
    const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
    exec(cmd, () => {});
});

// ========== 前端 HTML ==========
function getHTML() {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>钉钉签到导出</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
    background: #f0f2f5; color: #333; min-height: 100vh;
    display: flex; justify-content: center; padding-top: 40px;
}
.app {
    max-width: 780px; width: 95%; background: #fff; border-radius: 12px;
    box-shadow: 0 2px 12px rgba(0,0,0,0.08); padding: 32px;
}
h1 { text-align: center; font-size: 22px; margin-bottom: 24px; color: #1a1a1a; }

/* 部门 */
.field { margin-bottom: 20px; }
.field label { display: block; font-size: 14px; color: #666; margin-bottom: 6px; }
.field select {
    width: 100%; padding: 10px 12px; font-size: 15px;
    border: 1px solid #d9d9d9; border-radius: 8px; background: #fff;
    appearance: none; cursor: pointer;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23999' d='M6 8L1 3h10z'/%3E%3C/svg%3E");
    background-repeat: no-repeat; background-position: right 12px center;
}
.field select:focus { outline: none; border-color: #1677ff; box-shadow: 0 0 0 2px rgba(22,119,255,0.1); }

/* 日历 */
.calendar { margin-bottom: 20px; }
.cal-header {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 16px;
}
.cal-header .month-label { font-size: 16px; font-weight: 600; }
.cal-nav {
    width: 34px; height: 34px; border: 1px solid #d9d9d9; border-radius: 8px;
    background: #fff; cursor: pointer; font-size: 14px; color: #666;
    display: flex; align-items: center; justify-content: center; user-select: none;
}
.cal-nav:hover { border-color: #1677ff; color: #1677ff; }

.weekdays {
    display: grid; grid-template-columns: repeat(7, 1fr);
    text-align: center; font-size: 13px; color: #999; margin-bottom: 8px;
}
.weekend { color: #ff4d4f; }

.days {
    display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px;
}
.day {
    height: 40px; display: flex; align-items: center; justify-content: center;
    font-size: 14px; border-radius: 8px; cursor: pointer; user-select: none;
    transition: background 0.15s;
}
.day.anchor, .day.range-start, .day.range-end {
    background: #1677ff !important; color: #fff !important;
}
.day.anchor { border-radius: 8px; }
.day.pending-range { background: #bae0ff; border-radius: 0; }
.day.in-range { background: #e6f4ff; }
.day.range-start { border-radius: 8px 0 0 8px; }
.day.range-end { border-radius: 0 8px 8px 0; }
.day.range-start.range-end { border-radius: 8px; }
.day.other-month { color: #ccc; cursor: default; }
.day.today { font-weight: 700; color: #1677ff; }
.day.future { color: #ccc; cursor: not-allowed; }
.day.future:hover, .day.other-month:hover { background: transparent; }

/* 弹窗 */
.modal-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.4);
    display: flex; align-items: center; justify-content: center; z-index: 2000;
}
.modal-box {
    background: #fff; border-radius: 12px; padding: 24px 32px;
    max-width: 360px; text-align: center; box-shadow: 0 4px 20px rgba(0,0,0,0.15);
}
.modal-box .modal-icon { font-size: 32px; margin-bottom: 12px; }
.modal-box .modal-msg { font-size: 15px; color: #333; margin-bottom: 20px; }
.modal-box .modal-btn {
    padding: 8px 32px; font-size: 14px; border: none; border-radius: 6px;
    background: #1677ff; color: #fff; cursor: pointer;
}
.modal-box .modal-btn:hover { background: #4096ff; }

/* 选中的范围显示 */
.range-info {
    display: flex; gap: 16px; padding: 12px 16px;
    background: #f6f8fa; border-radius: 8px; margin-bottom: 24px;
    font-size: 14px;
}
.range-info .label { color: #999; }
.range-info .value { color: #333; font-weight: 500; }
.range-info .empty { color: #bbb; }

/* 按钮 */
.actions { display: flex; gap: 12px; }
.btn {
    flex: 1; padding: 12px 0; font-size: 15px; border: none; border-radius: 8px;
    cursor: pointer; font-weight: 500; transition: all 0.2s;
}
.btn-preview { background: #f0f2f5; color: #333; }
.btn-preview:hover { background: #e6e8eb; }
.btn-export { background: #1677ff; color: #fff; }
.btn-export:hover { background: #4096ff; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }

/* 结果提示 */
.toast {
    position: fixed; top: 20px; left: 50%; transform: translateX(-50%);
    padding: 12px 24px; border-radius: 8px; font-size: 14px;
    z-index: 1000; animation: fadeIn 0.3s;
}
.toast.success { background: #f6ffed; border: 1px solid #b7eb8f; color: #389e0d; }
.toast.error { background: #fff2f0; border: 1px solid #ffccc7; color: #cf1322; }
.toast.info { background: #e6f4ff; border: 1px solid #91caff; color: #0958d9; }
@keyframes fadeIn { from { opacity: 0; transform: translateX(-50%) translateY(-10px); } to { opacity: 1; transform: translateX(-50%) translateY(0); } }

/* 预览结果表格 */
.preview-results { margin-top: 24px; display: none; }
.preview-results.show { display: block; }
.preview-results h3 { font-size: 16px; margin-bottom: 8px; color: #333; }
.preview-summary { font-size: 14px; color: #666; margin-bottom: 12px; }
.preview-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.preview-table th, .preview-table td { padding: 8px 10px; text-align: left; border-bottom: 1px solid #f0f0f0; }
.preview-table th { background: #fafafa; color: #666; font-weight: 500; white-space: nowrap; }
.preview-table td { color: #333; font-size: 12px; word-break: break-all; }
.preview-table td a { color: #1677ff; text-decoration: none; }
.preview-table td a:hover { text-decoration: underline; }
</style>
</head>
<body>
<div class="app">
    <h1>📋 钉钉签到导出</h1>

    <div class="field">
        <label>部门</label>
        <select id="deptSelect"><option value="">加载中...</option></select>
    </div>

    <div class="calendar">
        <div class="cal-header">
            <button class="cal-nav" id="prevMonth">◀</button>
            <span class="month-label" id="monthLabel"></span>
            <button class="cal-nav" id="nextMonth">▶</button>
        </div>
        <div class="weekdays">
            <span class="weekend">日</span><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span class="weekend">六</span>
        </div>
        <div class="days" id="daysGrid"></div>
    </div>

    <div class="range-info">
        <span class="label">起始：</span><span class="value" id="startLabel"><span class="empty">点击日历选择</span></span>
        <span class="label">结束：</span><span class="value" id="endLabel"><span class="empty">再次点击选择</span></span>
    </div>

    <div class="actions">
        <button class="btn btn-preview" id="btnPreview" disabled>预览数据</button>
        <button class="btn btn-export" id="btnExport" disabled>导出 CSV</button>
    </div>

    <div class="preview-results" id="previewResults">
        <h3>📊 预览结果</h3>
        <p class="preview-summary" id="previewSummary"></p>
        <div style="overflow-x: auto;">
            <table class="preview-table">
                <thead><tr><th>序号</th><th>姓名</th><th>签到时间</th><th>地点</th><th>详细地址</th><th>备注</th></tr></thead>
                <tbody id="previewBody"></tbody>
            </table>
        </div>
    </div>
</div>
<script>
(function() {
    // ========== 状态 ==========
    // anchorDate 非空 → 选择中（悬停预览）；startDate 非空 → 已确认
    let anchorDate = null;   // {year, month, day} — 第一次点击的日期
    let hoverDate = null;    // {year, month, day} — 悬停中动态预览
    let startDate = null;    // {year, month, day} — 确认后的起始
    let endDate = null;      // {year, month, day} — 确认后的结束
    let viewYear, viewMonth;
    let daysInMonth;
    let dayCells = {};       // {dayNum: DOM element} — 本月日期格子引用
    const today = new Date();
    const TODAY_Y = today.getFullYear();
    const TODAY_M = today.getMonth() + 1;
    const TODAY_D = today.getDate();

    const deptSelect = document.getElementById('deptSelect');
    const monthLabel = document.getElementById('monthLabel');
    const daysGrid = document.getElementById('daysGrid');
    const startLabel = document.getElementById('startLabel');
    const endLabel = document.getElementById('endLabel');
    const btnPreview = document.getElementById('btnPreview');
    const btnExport = document.getElementById('btnExport');
    const prevBtn = document.getElementById('prevMonth');
    const nextBtn = document.getElementById('nextMonth');

    // ========== 工具 ==========
    function fmtDate(y, m, d) { return \`\${y}-\${pad2(m)}-\${pad2(d)}\`; }
    function pad2(n) { return String(n).padStart(2, '0'); }
    function formatTS(ts) { const d = new Date(ts); return \`\${fmtDate(d.getFullYear(), d.getMonth()+1, d.getDate())} \${pad2(d.getHours())}:\${pad2(d.getMinutes())}:\${pad2(d.getSeconds())}\`; }
    // 整数 key：y*10000+m*100+d，对合法日期严格单调，代替 new Date() 避免 GC 压力
    function dateKey(y, m, d) { return y * 10000 + m * 100 + d; }
    const TODAY_KEY = dateKey(TODAY_Y, TODAY_M, TODAY_D);
    // dateTS 仅用于 dayDiff（需要毫秒级时间戳做 DST 安全的日期差计算），点击时调用非热路径
    function dateTS(y, m, d) { return new Date(y, m - 1, d).getTime(); }

    function sortRange(a, b) {
        if (!a || !b) return [null, null];
        return dateKey(a.year, a.month, a.day) <= dateKey(b.year, b.month, b.day) ? [a, b] : [b, a];
    }

    function isFuture(y, m, d) {
        return dateKey(y, m, d) > TODAY_KEY;
    }

    function dayDiff(a, b) {
        return Math.round((dateTS(b.year, b.month, b.day) - dateTS(a.year, a.month, a.day)) / 86400000);
    }

    // ========== Toast ==========
    function showToast(msg, type) {
        const el = document.createElement('div');
        el.className = 'toast ' + type;
        el.textContent = msg;
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 3000);
    }

    // ========== 弹窗 ==========
    function showModal(msg, cb) {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.innerHTML = \`<div class="modal-box">
            <div class="modal-icon">⏰</div>
            <div class="modal-msg">\${msg}</div>
            <button class="modal-btn">知道了</button>
        </div>\`;
        document.body.appendChild(overlay);
        overlay.querySelector('.modal-btn').addEventListener('click', () => {
            overlay.remove();
            if (cb) cb();
        });
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) { overlay.remove(); if (cb) cb(); }
        });
    }

    // ========== 加载部门 ==========
    async function loadDepts() {
        try {
            const res = await fetch('/api/depts');
            const data = await res.json();
            if (data.error) { showToast(data.error, 'error'); return; }
            deptSelect.innerHTML = data.depts.map((d, i) => \`<option value="\${d.id}"\${i === 0 ? ' selected' : ''}>\${escHtml(d.name)}</option>\`).join('');
        } catch (e) {
            showToast('加载部门失败: ' + e.message, 'error');
        }
    }

    // ========== 日历渲染（全量重建 DOM，仅 click / 月份切换时调用）==========
    function renderCalendar() {
        monthLabel.textContent = \`\${viewYear}年 \${viewMonth}月\`;
        daysGrid.innerHTML = '';
        dayCells = {};

        const firstDay = new Date(viewYear, viewMonth - 1, 1).getDay(); // 0=Sun
        daysInMonth = new Date(viewYear, viewMonth, 0).getDate();
        const daysInPrev = new Date(viewYear, viewMonth - 1, 0).getDate();

        // 上月末尾
        for (let i = firstDay - 1; i >= 0; i--) {
            daysGrid.appendChild(mkOtherDay(daysInPrev - i));
        }

        // 本月日期
        for (let d = 1; d <= daysInMonth; d++) {
            const div = mkDay(d);
            daysGrid.appendChild(div);
            dayCells[d] = div;
        }

        // 下月开头
        const totalCells = firstDay + daysInMonth;
        const remaining = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);
        for (let d = 1; d <= remaining; d++) {
            daysGrid.appendChild(mkOtherDay(d));
        }

        applyDayStyles();
        updateUI();
    }

    function mkOtherDay(text) {
        const div = document.createElement('div');
        div.className = 'day other-month';
        div.textContent = text;
        return div;
    }

    function mkDay(d) {
        const div = document.createElement('div');
        div.className = 'day';
        div.textContent = d;

        // 今天标记（静态，不会随选择变化）
        if (TODAY_Y === viewYear && TODAY_M === viewMonth && TODAY_D === d) {
            div.classList.add('today');
        }

        const future = isFuture(viewYear, viewMonth, d);
        if (future) {
            div.classList.add('future');
        } else {
            div.addEventListener('click', () => onDayClick(viewYear, viewMonth, d));
            div.addEventListener('mouseenter', () => onDayHover(viewYear, viewMonth, d));
        }
        return div;
    }

    // 仅更新 CSS class，不重建 DOM（hover 专用）—— 全程整数 key 比较，零 Date 分配
    function applyDayStyles() {
        const [dsStart, dsEnd] = getDisplayRange();
        const startKey = dsStart ? dateKey(dsStart.year, dsStart.month, dsStart.day) : 0;
        const endKey = dsEnd ? dateKey(dsEnd.year, dsEnd.month, dsEnd.day) : 0;

        for (let d = 1; d <= daysInMonth; d++) {
            const div = dayCells[d];
            if (!div) continue;
            div.classList.remove('anchor','pending-range','in-range','range-start','range-end');

            const curKey = dateKey(viewYear, viewMonth, d);

            // 确认后的范围高亮
            if (startDate && startKey) {
                if (dsStart && viewYear === dsStart.year && viewMonth === dsStart.month && d === dsStart.day)
                    div.classList.add('range-start');
                if (dsEnd && viewYear === dsEnd.year && viewMonth === dsEnd.month && d === dsEnd.day)
                    div.classList.add('range-end');
                if (curKey > startKey && curKey < endKey)
                    div.classList.add('in-range');
            }

            // 动态预览高亮（锚点已选，尚未确认）
            if (anchorDate && !startDate) {
                if (viewYear === anchorDate.year && viewMonth === anchorDate.month && d === anchorDate.day)
                    div.classList.add('anchor');
                if (hoverDate && startKey && curKey >= startKey && curKey <= endKey &&
                    !(viewYear === anchorDate.year && viewMonth === anchorDate.month && d === anchorDate.day)) {
                    div.classList.add('pending-range');
                }
            }
        }
    }

    function getDisplayRange() {
        if (anchorDate && hoverDate) return sortRange(anchorDate, hoverDate);
        if (startDate && endDate) return [startDate, endDate];
        if (anchorDate) return [anchorDate, anchorDate];
        return [null, null];
    }

    // ========== 离开日历清除悬停 ==========
    daysGrid.addEventListener('mouseleave', () => {
        if (anchorDate && !startDate && hoverDate) {
            hoverDate = null;
            applyDayStyles();
        }
    });

    // ========== 事件处理 ==========
    function onDayHover(y, m, d) {
        if (!anchorDate || startDate) return;
        if (y !== viewYear || m !== viewMonth) return;
        hoverDate = { year: y, month: m, day: d };
        applyDayStyles();
    }

    function onDayClick(y, m, d) {
        const clicked = { year: y, month: m, day: d };

        // 已确认或无锚点 → (重新)开始选择
        if (startDate || !anchorDate) {
            anchorDate = clicked;
            hoverDate = null;
            startDate = null;
            endDate = null;
            applyDayStyles();
            updateUI();
            return;
        }

        // 锚点已设 → 完成范围选择
        const [s, e] = sortRange(anchorDate, clicked);
        if (dayDiff(s, e) > 31) {
            showModal('自定义日期跨度不能超过31天', () => {
                anchorDate = null;
                hoverDate = null;
                applyDayStyles();
                updateUI();
            });
            return;
        }
        startDate = s;
        endDate = e;
        anchorDate = null;
        hoverDate = null;
        applyDayStyles();
        updateUI();
    }

    function updateUI() {
        // 更新范围标签
        if (startDate && endDate) {
            startLabel.textContent = fmtDate(startDate.year, startDate.month, startDate.day);
            endLabel.textContent = fmtDate(endDate.year, endDate.month, endDate.day);
        } else if (anchorDate) {
            startLabel.textContent = fmtDate(anchorDate.year, anchorDate.month, anchorDate.day);
            endLabel.innerHTML = '<span class="empty">悬停预览 / 点击确认</span>';
        } else {
            startLabel.innerHTML = '<span class="empty">点击日历选择</span>';
            endLabel.innerHTML = '<span class="empty">悬停预览 / 点击确认</span>';
        }
        // 更新按钮状态
        const ok = !!startDate;
        btnPreview.disabled = !ok;
        btnExport.disabled = !ok;
    }

    // ========== 月份导航 ==========
    function navigateMonth(delta) {
        viewMonth += delta;
        if (viewMonth < 1) { viewMonth = 12; viewYear--; }
        else if (viewMonth > 12) { viewMonth = 1; viewYear++; }
        if (anchorDate && !startDate) hoverDate = null;
        renderCalendar();
    }
    prevBtn.addEventListener('click', () => navigateMonth(-1));
    nextBtn.addEventListener('click', () => navigateMonth(1));

    // ========== 获取选中参数 ==========
    function getParams() {
        if (!startDate || !endDate) return null;
        const deptId = parseInt(deptSelect.value) || 0;
        const selOpt = deptSelect.options[deptSelect.selectedIndex];
        const deptName = selOpt ? selOpt.text : '未知';
        const startTime = dateTS(startDate.year, startDate.month, startDate.day);
        const endTime = dateTS(endDate.year, endDate.month, endDate.day) + 86399000;
        return { deptId, deptName, startTime, endTime, startYear: startDate.year, startMonth: startDate.month, endYear: endDate.year, endMonth: endDate.month };
    }

    // ========== 预览 ==========
    const previewResults = document.getElementById('previewResults');
    const previewSummary = document.getElementById('previewSummary');
    const previewBody = document.getElementById('previewBody');

    btnPreview.addEventListener('click', async () => {
        btnPreview.disabled = true;
        btnPreview.textContent = '加载中...';
        previewResults.classList.remove('show');
        try {
            const params = getParams();
            if (!params) { showToast('请先选择日期范围和部门', 'error'); return; }
            if (!params.deptId) { showToast('请选择部门', 'error'); return; }
            const res = await fetch('/api/preview', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(params)
            });
            const data = await res.json();
            if (data.error) { showToast(data.error, 'error'); return; }
            previewSummary.textContent = \`共 \${data.total} 条签到记录，预览前 \${data.preview.length} 条\`;
            previewBody.innerHTML = data.preview.map((r, i) => {
                const remark = (r.remark || '').match(/[a-zA-Z0-9]+/g);
                const remarkStr = remark ? remark.slice(0, 3).join(', ') : '';
                return \`<tr>
                    <td>\${i + 1}</td>
                    <td>\${escHtml(r.name || '')}</td>
                    <td>\${formatTS(r.timestamp)}</td>
                    <td>\${escHtml(r.place || '')}</td>
                    <td>\${escHtml(r.detailPlace || '')}</td>
                    <td>\${escHtml(remarkStr)}</td>
                </tr>\`;
            }).join('');
            previewResults.classList.add('show');
            showToast(\`共 \${data.total} 条签到记录\`, 'success');
        } catch (e) {
            showToast('预览失败: ' + e.message, 'error');
        } finally {
            btnPreview.disabled = false;
            btnPreview.textContent = '预览数据';
        }
    });

    function escHtml(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // ========== 导出 ==========
    // 关闭页面时自动关闭服务器
    window.addEventListener('beforeunload', () => {
        navigator.sendBeacon('/api/shutdown');
    });

    btnExport.addEventListener('click', async () => {
        btnExport.disabled = true;
        btnExport.textContent = '导出中...';
        try {
            const params = getParams();
            if (!params) { showToast('请先选择日期范围和部门', 'error'); return; }
            if (!params.deptId) { showToast('请选择部门', 'error'); return; }
            const res = await fetch('/api/export', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(params)
            });
            if (!res.ok) {
                const err = await res.json();
                showToast(err.error || '导出失败', 'error');
                return;
            }
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            const disp = res.headers.get('Content-Disposition') || '';
            const m = disp.match(/filename="?([^"]+)"?/);
            a.download = m ? decodeURIComponent(m[1]) : '签到导出.csv';
            a.click();
            URL.revokeObjectURL(url);
            showToast('导出成功！', 'success');
        } catch (e) {
            showToast('导出失败: ' + e.message, 'error');
        } finally {
            btnExport.disabled = false;
            btnExport.textContent = '导出 CSV';
        }
    });

    // ========== 初始化 ==========
    viewYear = TODAY_Y;
    viewMonth = TODAY_M;
    loadDepts();
    renderCalendar();
})();
</script>
</body>
</html>`;
}
