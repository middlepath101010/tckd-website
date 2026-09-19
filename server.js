'use strict';

/**
 * TC EXPRESS · 网站 + 安全运单查询接口
 *
 * 职责：
 *   1) 托管 site/ 下的静态网站（index.html / query.html / assets …）
 *   2) 提供 GET /api/track?no=单号
 *        - 用「国内快递单号」或「TC 运单号」查询，二者指向同一票货
 *        - 只返回物流状态（状态 / 最新节点 / 更新时间 / 轨迹节点），
 *          绝不返回收件人与货物（冒领三件套，永不外泄）
 *        - 后端只回传命中的那一行，绝不返回整张表（防批量扒数据）
 *        - 带按 IP 的轻量限流
 *
 * 数据源（二选一）：
 *   - 生产：设置环境变量 GOOGLE_SHEET_ID + GOOGLE_CREDENTIALS（服务账号 JSON 字符串），
 *           从谷歌表格读取（表格保持私有，仅服务账号可访问）
 *   - 本地 / 兜底：读取 data/shipments.csv（仅用于本地预览与无凭据时的测试）
 *
 * 谷歌表格列（首行表头）：
 *   运单号, 国内快递公司, 国内快递单号, 状态, 最新节点, 更新时间, 收件人, 货物, 轨迹
 *   - 运单号 可空：货物还没到仓、尚未分配 TC 号时，用「国内快递单号」查询
 *   - 收件人 / 货物 仅作内部作业使用，接口一律不返回
 *   - 「轨迹」列每行为一个节点，格式：时间 || 节点描述（换行分隔多个节点）
 */

const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = __dirname;

/* ----------------------------- 轻量限流 ----------------------------- */
const hits = new Map();
const LIMIT = 40;            // 每窗口最多请求数
const WINDOW = 60 * 1000;    // 窗口长度（毫秒）
function rateLimited(ip) {
  const now = Date.now();
  const rec = hits.get(ip) || { t: now, n: 0 };
  if (now - rec.t > WINDOW) { rec.t = now; rec.n = 0; }
  rec.n += 1;
  hits.set(ip, rec);
  return rec.n > LIMIT;
}

/* --------------------------- 数据读取层 --------------------------- */
let sheetCache = { at: 0, data: null };

async function loadRows() {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  const creds = process.env.GOOGLE_CREDENTIALS;
  if (sheetId && creds) {
    // 缓存 60s，避免每次查询都打谷歌接口
    if (sheetCache.data && Date.now() - sheetCache.at < 60000) return sheetCache.data;
    const { GoogleSpreadsheet } = require('google-spreadsheet');
    const doc = new GoogleSpreadsheet(sheetId);
    await doc.useServiceAccountAuth(JSON.parse(creds));
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    const rows = await sheet.getRows();
    const data = rows
      .map((r) => {
        const obj = {};
        sheet.headerValues.forEach((h) => { obj[h] = r[h]; });
        return normalize(obj);
      })
      .filter(Boolean);
    sheetCache = { at: Date.now(), data };
    return data;
  }
  return readCsv();
}

function normalize(r) {
  if (!r) return null;
  const get = (keys) => {
    for (const k of keys) {
      const v = r[k];
      if (v != null && String(v).trim() !== '') return String(v).trim();
    }
    return '';
  };
  // 主键可以是 TC 运单号，也可以是国内快递单号（货物还没到仓、尚未分配 TC 号时用）
  const no = get(['运单号', 'tracking_no', 'TrackingNo', 'tracking']);
  const domesticNo = get(['国内快递单号', 'domestic_no', 'domestic', '快递单号']);
  if (!no && !domesticNo) return null;
  const timelineRaw = get(['轨迹', 'timeline', 'events']);
  return {
    no: no || '',
    domesticCourier: get(['国内快递公司', 'domestic_courier', 'courier', '快递公司']),
    domesticNo: domesticNo || '',
    status: get(['状态', 'status']),
    latest: get(['最新节点', 'latest', 'node']),
    updated_at: get(['更新时间', 'updated_at', 'time']),
    // 注意：表里即使有「收件人 / 货物」列，这里也刻意不读进内存——
    // 读进来就有被误写进响应的风险，不读是最稳妥的防泄漏做法。
    timeline: parseTimeline(timelineRaw)
  };
}

function parseTimeline(raw) {
  if (!raw) return [];
  return raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.split(/\s*\|\|?\s*/);
      if (m.length >= 2) return { time: m[0], node: m.slice(1).join(' | ') };
      return { time: '', node: line };
    });
}

function readCsv() {
  const file = path.join(PUBLIC_DIR, 'data', 'shipments.csv');
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8').trim();
  const lines = parseCsv(text);
  if (lines.length < 2) return [];
  const headers = lines[0].map((h) => h.trim());
  return lines
    .slice(1)
    .map((cells) => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = cells[i] != null ? cells[i] : ''; });
      return normalize(obj);
    })
    .filter(Boolean);
}

// 极简 CSV 解析：支持引号包裹与字段内换行/逗号
function parseCsv(text) {
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c === '\r') { /* skip */ }
    else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

/* ----------------------------- 接口 ----------------------------- */
app.get('/api/track', async (req, res) => {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '');
  if (rateLimited(ip)) return res.status(429).json({ found: false, reason: 'rate_limited' });

  // 清掉空格（用户常复制出首尾空格），国内单号可能较长
  const noRaw = String(req.query.no || '').replace(/\s+/g, '').trim();

  if (!/^[A-Za-z0-9\-]{4,60}$/.test(noRaw)) {
    return res.status(400).json({ found: false, reason: 'bad_input' });
  }

  try {
    const rows = await loadRows();

    // 「国内快递单号」与「TC 运单号」指向同一票货，任一命中即可
    const hit = rows.find(
      (r) =>
        (r.no && r.no.toUpperCase() === noRaw.toUpperCase()) ||
        (r.domesticNo && r.domesticNo.toUpperCase() === noRaw.toUpperCase())
    );
    if (!hit) return res.json({ found: false, reason: 'not_found' });

    // 只回传物流状态：收件人 / 货物 永不出现在响应里
    return res.json({
      found: true,
      tracking_no: hit.no || '',
      tcd_no: hit.no || '',
      domestic: { courier: hit.domesticCourier, no: hit.domesticNo },
      status: hit.status,
      latest: hit.latest,
      updated_at: hit.updated_at,
      timeline: hit.timeline
    });
  } catch (e) {
    console.error('[track] error:', e);
    return res.status(500).json({ found: false, reason: 'server_error' });
  }
});

/* --------------------------- 静态托管 --------------------------- */
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));
app.use((req, res) => res.status(404).send('Not found'));

app.listen(PORT, '0.0.0.0', () => {
  console.log('TC EXPRESS site listening on http://0.0.0.0:' + PORT);
});
