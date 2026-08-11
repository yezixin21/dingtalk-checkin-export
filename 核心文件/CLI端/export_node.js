const fs = require('fs');
const path = require('path');
const { setTimeout: sleep } = require('timers/promises');
const { loadEnv } = require('../load_env');

// ========== 配置初始化 ==========
loadEnv(path.join(__dirname, '..', '..', '.env'));

const appkey = process.env.DINGTALK_APPKEY;
const appsecret = process.env.DINGTALK_APPSECRET;
if (!appkey || !appsecret) {
    console.error('错误：未设置 DINGTALK_APPKEY / DINGTALK_APPSECRET 环境变量');
    console.error('请复制 .env.example 为 .env 并填入凭据，或直接在系统中设置环境变量');
    process.exit(1);
}

const config = require('../config.json');
const outputPath = config.outputPath || path.join(__dirname, '..');
const departmentId = config.department_id || 1;

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

    // 2. 获取部门名称
    let deptName = '部门' + departmentId;
    try {
        const deptRes = await httpGet(`https://oapi.dingtalk.com/department/list?access_token=${token}`);
        if (deptRes.errcode === 0 && deptRes.department) {
            const found = deptRes.department.find(d => d.id === departmentId);
            if (found) deptName = found.name;
        }
    } catch (_) {}
    console.log(`部门: ${deptName} (ID: ${departmentId})`);

    // 3. 并行分页拉取签到记录
    const allData = [];

    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const day = now.getDate();
    const startTime = new Date(`${year}-${pad2(month)}-01T00:00:00+08:00`).getTime();
    const endTime = new Date(`${year}-${pad2(month)}-${pad2(day)}T23:59:59+08:00`).getTime();

    console.log(`日期范围: ${year}-${month}-01 至 ${day}`);

    const urlBase = `https://oapi.dingtalk.com/checkin/record?access_token=${token}&department_id=${departmentId}&start_time=${startTime}&end_time=${endTime}&size=${PAGE_SIZE}&order=desc`;

    async function loadPage(offset) {
        const json = await httpGet(`${urlBase}&offset=${offset}`);
        if (json.errcode !== 0) throw new Error(json.errmsg);
        return { count: json.data?.length || 0, records: json.data || [] };
    }

    // 第一页先串行拉，确定是否有数据
    const first = await loadPage(0);
    console.log(`第 1 页: ${first.count} 条`);
    allData.push(...first.records);

    // 如果第一页满了，并行拉剩余页
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

    // 4. 保存 CSV
    saveToCSV(allData, year, month, deptName);
}

// ========== CSV 生成 ==========

function saveToCSV(data, year, month, deptName) {
    // 按时间排序（早 → 晚）
    data.sort((a, b) => a.timestamp - b.timestamp);

    // 预扫描：计算最大图片数
    const maxImages = Math.max(0, ...data.map(r => (r.imageList || []).length));

    // 构建表头
    const imageHeaders = Array.from({ length: maxImages }, (_, i) => `,图${i + 1}`).join('');
    const header = `序号,姓名,签到时间,签到地点,详细地址,纬度,经度,备注${imageHeaders}`;

    // 单次遍历：构建 CSV 行
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
    const safeName = deptName.replace(/[\\/:*?"<>|]/g, '_');
    const filename = `签到${year}_${pad2(month)}_${safeName}.csv`;
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
