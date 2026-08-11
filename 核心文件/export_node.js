const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { setTimeout: sleep } = require('timers/promises');
const { loadEnv } = require('./load_env');

// ========== 配置初始化 ==========
loadEnv(path.join(__dirname, '..', '.env'));

const appkey = process.env.DINGTALK_APPKEY;
const appsecret = process.env.DINGTALK_APPSECRET;
if (!appkey || !appsecret) {
    console.error('错误：未设置 DINGTALK_APPKEY / DINGTALK_APPSECRET 环境变量');
    console.error('请复制 .env.example 为 .env 并填入凭据，或直接在系统中设置环境变量');
    process.exit(1);
}

const config = require('./config.json');
const outputPath = config.outputPath || path.join(__dirname, '..');

// ========== 常量 ==========

const RETRY_DELAY_MS = 1000;
const BATCH_THROTTLE_MS = 100;
const PAGE_SIZE = 100;
const CONCURRENCY = 3;

const RE_ALNUM = /[a-zA-Z0-9]+/g;
const RE_DQUOTE = /"/g;

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
            console.warn(`请求失败，重试 ${i + 1}/${retries}...`);
            await sleep(RETRY_DELAY_MS);
        }
    }
}

// ========== 交互式输入 ==========

function question(rl, prompt) {
    return new Promise(resolve => rl.question(prompt, resolve));
}

function createRL() {
    return readline.createInterface({ input: process.stdin, output: process.stdout });
}

// ========== 部门选择 ==========

async function selectDepartment(token) {
    console.log('\n正在获取部门列表...');
    const res = await httpGet(`https://oapi.dingtalk.com/department/list?access_token=${token}`);

    if (res.errcode !== 0 || !res.department || res.department.length === 0) {
        console.log('未找到部门，使用默认部门 ID: 1');
        return { id: 1, name: '默认部门' };
    }

    const depts = res.department.sort((a, b) => a.id - b.id);

    console.log('\n========== 可用部门 ==========');
    depts.forEach((d, i) => console.log(`  [${i + 1}] ${d.name} (ID: ${d.id})`));
    console.log('');

    const rl = createRL();
    let choice;
    while (true) {
        const input = await question(rl, `请选择部门 [1-${depts.length}]（默认 1）: `);
        if (input.trim() === '') { choice = 0; break; }
        const n = parseInt(input, 10);
        if (n >= 1 && n <= depts.length) { choice = n - 1; break; }
        console.log(`请输入 1-${depts.length} 之间的数字`);
    }
    rl.close();

    const selected = depts[choice];
    console.log(`已选择: ${selected.name} (ID: ${selected.id})\n`);
    return selected;
}

// ========== 日期范围选择 ==========

async function selectDateRange() {
    const now = new Date();
    const curYear = now.getFullYear();
    const curMonth = now.getMonth() + 1;
    const curDay = now.getDate();

    const rl = createRL();

    console.log('========== 导出时间范围 ==========');
    console.log('输入格式: YYYY-MM，如 2026-08');
    console.log('直接回车使用默认值（本月 1 日 ~ 今天）\n');

    // 起始年月
    let startYear, startMonth;
    while (true) {
        const input = await question(rl, `起始年月（默认 ${curYear}-${pad2(curMonth)}）: `);
        if (input.trim() === '') {
            startYear = curYear;
            startMonth = curMonth;
            break;
        }
        const m = input.match(/^(\d{4})-(\d{1,2})$/);
        if (m) {
            startYear = parseInt(m[1], 10);
            startMonth = parseInt(m[2], 10);
            if (startMonth >= 1 && startMonth <= 12) break;
        }
        console.log('格式错误，请输入如 2026-01');
    }

    // 结束年月
    let endYear, endMonth;
    while (true) {
        const input = await question(rl, `结束年月（默认 ${curYear}-${pad2(curMonth)}）: `);
        if (input.trim() === '') {
            endYear = curYear;
            endMonth = curMonth;
            break;
        }
        const m = input.match(/^(\d{4})-(\d{1,2})$/);
        if (m) {
            endYear = parseInt(m[1], 10);
            endMonth = parseInt(m[2], 10);
            if (endMonth >= 1 && endMonth <= 12) break;
        }
        console.log('格式错误，请输入如 2026-08');
    }

    rl.close();

    // 计算时间戳
    const startTime = new Date(`${startYear}-${pad2(startMonth)}-01T00:00:00+08:00`).getTime();
    // 结束时间：如果结束月份是当前月份，到"今天"为止；否则到月底
    let endDay;
    if (endYear === curYear && endMonth === curMonth) {
        endDay = curDay;
    } else {
        endDay = new Date(endYear, endMonth, 0).getDate(); // 当月最后一天
    }
    const endTime = new Date(`${endYear}-${pad2(endMonth)}-${pad2(endDay)}T23:59:59+08:00`).getTime();

    console.log(`时间范围: ${startYear}-${pad2(startMonth)}-01 ~ ${endYear}-${pad2(endMonth)}-${pad2(endDay)}\n`);

    return { startTime, endTime, startYear, startMonth, endYear, endMonth };
}

// ========== 主流程 ==========

async function main() {
    // 1. 获取 token
    console.log('正在获取 token...');
    const tokenRes = await httpGet(`https://oapi.dingtalk.com/gettoken?appkey=${appkey}&appsecret=${appsecret}`);
    if (!tokenRes.access_token) {
        throw new Error(`获取 token 失败: ${JSON.stringify(tokenRes)}`);
    }
    const token = tokenRes.access_token;
    console.log('Token:', token.substring(0, 10) + '...');

    // 2. 选择部门
    const dept = await selectDepartment(token);
    const departmentId = dept.id;

    // 3. 选择日期范围
    const { startTime, endTime, startYear, startMonth, endYear, endMonth } = await selectDateRange();

    // 4. 并行分页拉取签到记录
    const allData = [];

    const urlBase = `https://oapi.dingtalk.com/checkin/record?access_token=${token}&department_id=${departmentId}&start_time=${startTime}&end_time=${endTime}&size=${PAGE_SIZE}&order=desc`;

    async function loadPage(offset) {
        const json = await httpGet(`${urlBase}&offset=${offset}`);
        if (json.errcode !== 0) throw new Error(json.errmsg);
        return { count: json.data?.length || 0, records: json.data || [] };
    }

    const first = await loadPage(0);
    console.log(`第 1 页: ${first.count} 条`);
    allData.push(...first.records);

    if (first.count >= PAGE_SIZE) {
        let batchOffset = PAGE_SIZE;

        outer:
        while (true) {
            const offsets = Array.from({ length: CONCURRENCY }, (_, i) => batchOffset + i * PAGE_SIZE);
            const results = await Promise.all(offsets.map(o => loadPage(o)));

            for (let i = 0; i < results.length; i++) {
                const r = results[i];
                console.log(`第 ${batchOffset / PAGE_SIZE + 1 + i} 页: ${r.count} 条`);
                allData.push(...r.records);
                if (r.count < PAGE_SIZE) break outer;
            }

            batchOffset += CONCURRENCY * PAGE_SIZE;
            await sleep(BATCH_THROTTLE_MS);
        }
    }

    console.log(`共获取 ${allData.length} 条记录`);

    if (allData.length === 0) {
        console.log('无数据，退出');
        return;
    }

    // 5. 保存 CSV
    saveToCSV(allData, startYear, startMonth, endYear, endMonth, dept.name);
}

// ========== CSV 生成 ==========

function saveToCSV(data, startYear, startMonth, endYear, endMonth, deptName) {
    data.sort((a, b) => a.timestamp - b.timestamp);

    const maxImages = Math.max(0, ...data.map(r => (r.imageList || []).length));

    const imageHeaders = Array.from({ length: maxImages }, (_, i) => `,图${i + 1}`).join('');
    const header = `序号,姓名,签到时间,签到地点,详细地址,纬度,经度,备注${imageHeaders}`;

    const csvLines = [header];
    data.forEach((record, index) => {
        const baseCols = [
            index + 1,
            csvEscape(record.name),
            formatTimestamp(record.timestamp),
            csvEscape(record.place),
            csvEscape(record.detailPlace),
            record.latitude ?? '',
            record.longitude ?? '',
            normalizeRemark(record.remark),
        ];
        const imageCols = (record.imageList || []).map(csvEscape);
        while (imageCols.length < maxImages) imageCols.push('');
        const cols = [...baseCols, ...imageCols];
        csvLines.push('"' + cols.join('","') + '"');
    });

    const BOM = '﻿';
    const csv = BOM + csvLines.join('\n') + '\n';

    // 文件名：签到2026_08-09_部门名称.csv（跨月用 - 连接，单月只写一个）
    const dateStr = startYear === endYear && startMonth === endMonth
        ? `${startYear}_${pad2(startMonth)}`
        : `${startYear}_${pad2(startMonth)}-${pad2(endMonth)}`;
    const safeName = deptName.replace(/[\\/:*?"<>|]/g, '_');
    const filename = `签到${dateStr}_${safeName}.csv`;
    const csvPath = path.join(outputPath, filename);

    fs.writeFileSync(csvPath, csv, 'utf8');

    console.log('===========================');
    console.log('保存至:', csvPath);
    console.log('记录数:', data.length);
}

// ========== 入口 ==========
main().catch(e => {
    console.error('运行失败:', e.message);
    process.exit(1);
});
