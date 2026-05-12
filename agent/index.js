// agent/index.js
// Radar Agent — WhatsApp 双向对话 + 定时监控
// RUN_MODE=webhook  → 处理单条 WhatsApp 消息
// RUN_MODE=monitor  → 定时检查所有 radar

import Anthropic from "@anthropic-ai/sdk";
import twilio from "twilio";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "../data");
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

// ── 环境变量 ────────────────────────────────────────────
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const TWILIO_SID    = process.env.TWILIO_SID;
const TWILIO_TOKEN  = process.env.TWILIO_TOKEN;
const WA_FROM       = process.env.WHATSAPP_FROM;
const WA_TO         = process.env.WHATSAPP_TO;
const RUN_MODE      = process.env.RUN_MODE || "monitor";
const MSG_FROM      = process.env.WA_FROM;    // webhook 模式：发消息的人
const MSG_TEXT      = process.env.WA_MESSAGE; // webhook 模式：消息内容
const BIT_APP_ID    = "radar-agent";

// ── 客户端 ──────────────────────────────────────────────
const ai   = new Anthropic({ apiKey: ANTHROPIC_KEY });
const twil = twilio(TWILIO_SID, TWILIO_TOKEN);

// ── 数据读写 ─────────────────────────────────────────────
const radarPath  = join(DATA_DIR, "radars.json");
const resultPath = join(DATA_DIR, "results.json");

function readRadars()   { return existsSync(radarPath)  ? JSON.parse(readFileSync(radarPath,  "utf8")) : []; }
function readResults()  { return existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, "utf8")) : []; }
function saveRadars(d)  { writeFileSync(radarPath,  JSON.stringify(d, null, 2)); }
function saveResults(d) { writeFileSync(resultPath, JSON.stringify(d, null, 2)); }
function sleep(ms)      { return new Promise(r => setTimeout(r, ms)); }

function makeId(label) {
  return label.toLowerCase().replace(/[^\w\s]/g, "").trim()
    .replace(/\s+/g, "-").slice(0, 30) + "-" + Date.now().toString(36);
}

// ── WHATSAPP 发送 ────────────────────────────────────────
async function sendWA(to, body) {
  try {
    await twil.messages.create({ from: WA_FROM, to, body });
    console.log(`✓ WhatsApp → ${to}`);
  } catch(e) {
    console.error("WhatsApp 失败:", e.message);
  }
}

// ── Bandsintown API（演唱会专用）─────────────────────────
async function fetchBandsintown(artistName) {
  try {
    const encoded = encodeURIComponent(artistName);
    const url = `https://rest.bandsintown.com/artists/${encoded}/events?app_id=${BIT_APP_ID}`;
    const resp = await fetch(url);
    if (!resp.ok) return [];
    const events = await resp.json();
    if (!Array.isArray(events)) return [];
    return events.map(e => ({
      source: "bandsintown",
      title: `${artistName} · ${e.venue?.name || ""}`,
      url: e.url || `https://bandsintown.com`,
      date: e.datetime ? e.datetime.split("T")[0] : null,
      location: [e.venue?.city, e.venue?.country].filter(Boolean).join(", "),
      summary: `${artistName} 演出：${e.venue?.name || ""}，${e.venue?.city || ""}，${e.datetime?.split("T")[0] || ""}`,
    }));
  } catch(e) {
    console.error("Bandsintown 失败:", e.message);
    return [];
  }
}

// ── Web Search（兜底）────────────────────────────────────
async function fetchWebSearch(queries) {
  let allText = "";
  for (const query of queries) {
    try {
      console.log(`  搜索: ${query}`);
      const resp = await ai.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 800,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{ role: "user", content: `Search: ${query}\nReturn top 5 results with title, URL, brief description.` }],
      });
      const text = resp.content.filter(b => b.type === "text").map(b => b.text).join("\n");
      allText += `\n\n--- ${query} ---\n${text}`;
      await sleep(1200);
    } catch(e) {
      console.error(`  搜索失败: ${e.message}`);
    }
  }
  return allText;
}

// ── 选择数据源 ───────────────────────────────────────────
async function fetchForRadar(radar) {
  if (radar.type === "concert" && radar.artist) {
    console.log(`  → Bandsintown: ${radar.artist}`);
    const events = await fetchBandsintown(radar.artist);
    if (events.length > 0) return { source: "bandsintown", events };
  }
  console.log(`  → Web Search`);
  const text = await fetchWebSearch(radar.queries);
  return { source: "websearch", text };
}

// ── 评估结果 ─────────────────────────────────────────────
async function evaluate(radar, fetchResult, seenUrls) {
  if (fetchResult.source === "bandsintown") {
    return fetchResult.events.filter(e => !seenUrls.includes(e.url));
  }
  if (!fetchResult.text?.trim()) return [];

  const resp = await ai.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1500,
    messages: [{
      role: "user",
      content: `评估搜索结果是否符合监控意图。

意图：${radar.intent}

结果：
${fetchResult.text}

已见过的 URL（跳过）：
${seenUrls.join("\n") || "无"}

只返回 JSON 数组，最多3条，格式：
[{"title":"...","url":"...","date":"...","location":"...","summary":"一句话总结"}]

没有相关新结果返回 []`
    }]
  });

  try {
    const text = resp.content.find(b => b.type === "text")?.text || "[]";
    const clean = text.replace(/```json|```/g, "").trim();
    // 修复截断的 JSON
    const lastBracket = clean.lastIndexOf("]");
    const fixed = lastBracket > -1 ? clean.slice(0, lastBracket + 1) : "[]";
    return JSON.parse(fixed);
  } catch { return []; }
}

// ── 格式化推送消息 ────────────────────────────────────────
function formatAlert(radar, results) {
  if (results.length === 1) {
    const r = results[0];
    return [
      `*🎯 ${radar.label}*`,
      ``,
      r.summary,
      r.date     ? `📅 ${r.date}` : null,
      r.location ? `📍 ${r.location}` : null,
      `🔗 ${r.url}`,
      ``,
      `_来源: ${radar.type === "concert" ? "Bandsintown" : "网络搜索"} · 发 LIST 管理_`,
    ].filter(l => l !== null).join("\n");
  }
  const lines = [`*🎯 ${radar.label} · ${results.length}条新消息*`, ``];
  results.slice(0, 3).forEach((r, i) => {
    lines.push(`*${i+1}.* ${r.title}`);
    lines.push(r.summary);
    if (r.date)     lines.push(`📅 ${r.date}`);
    if (r.location) lines.push(`📍 ${r.location}`);
    lines.push(`🔗 ${r.url}`, ``);
  });
  lines.push(`_发 LIST 管理 · STOP [n] 暂停_`);
  return lines.join("\n");
}

// ── 频率判断 ─────────────────────────────────────────────
function isDue(radar) {
  if (!radar.active) return false;
  if (!radar.last_checked) return true;
  const hours = (Date.now() - new Date(radar.last_checked)) / 3600000;
  return radar.frequency === "twice-daily" ? hours >= 12
       : radar.frequency === "weekly"      ? hours >= 168
       : hours >= 24;
}

// ── 监控主循环 ───────────────────────────────────────────
async function runMonitorCycle() {
  console.log(`\n[${new Date().toISOString()}] 监控开始`);
  const radars = readRadars();
  const due = radars.filter(isDue);
  console.log(`需要检查: ${due.length}/${radars.length}`);

  for (const radar of due) {
    console.log(`\n→ ${radar.label}`);
    const seen = readResults().filter(r => r.radar_id === radar.id).map(r => r.url);
    const fetchResult = await fetchForRadar(radar);
    const newResults  = await evaluate(radar, fetchResult, seen);
    console.log(`  新结果: ${newResults.length}`);

    const all = readRadars();
    const idx = all.findIndex(r => r.id === radar.id);
    if (idx !== -1) {
      all[idx].last_checked = new Date().toISOString();
      if (newResults.length > 0) all[idx].last_result = new Date().toISOString();
      saveRadars(all);
    }

    if (newResults.length === 0) { await sleep(1000); continue; }

    const saved = readResults();
    const now = new Date().toISOString();
    newResults.forEach(r => saved.push({ radar_id: radar.id, found_at: now, ...r, notified: true }));
    saveResults(saved);

    const target = radar.owner || WA_TO;
    await sendWA(target, formatAlert(radar, newResults.slice(0, 3)));
    await sleep(2000);
  }
  console.log("监控完成");
}

// ── 解析用户指令 ─────────────────────────────────────────
async function parseIntent(userMsg) {
  const radars = readRadars();
  const list = radars.map((r, i) =>
    `${i+1}. ${r.label}（${r.type === "concert" ? "演唱会" : "搜索"}，${r.frequency}，${r.active ? "监控中" : "已暂停"}）`
  ).join("\n") || "暂无";

  const resp = await ai.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 500,
    messages: [{
      role: "user",
      content: `你是监控助手指令解析器。只返回 JSON，不要其他内容。

用户消息：「${userMsg}」
当前监控列表：
${list}

判断规则：
- 提到艺人/乐队/演唱会/巡演/concert/tour → add concert
- 提到活动/event/meetup/新闻/消息/监控/关注 → add search  
- LIST/列表/我的监控 → list
- STOP+数字/暂停+数字 → stop
- DELETE+数字/删除+数字 → delete
- RESUME+数字/恢复+数字 → resume
- YES/确认 → confirm
- 其他 → help

返回格式：
新增演唱会：{"action":"add","type":"concert","label":"艺人名 演唱会","artist":"英文艺人名","intent":"监控该艺人演唱会巡演信息","queries":[],"frequency":"daily"}
新增搜索：{"action":"add","type":"search","label":"简短名称","artist":null,"intent":"详细描述要监控的内容","queries":["英文搜索词1","英文搜索词2","中文搜索词"],"frequency":"daily"}
查看列表：{"action":"list"}
暂停：{"action":"stop","index":数字}
删除：{"action":"delete","index":数字}
恢复：{"action":"resume","index":数字}
确认：{"action":"confirm"}
其他：{"action":"help"}`
    }]
  });

  try {
    const text = resp.content.find(b => b.type === "text")?.text || "{}";
    return JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch { return { action: "help" }; }
}

// ── 处理用户消息 ─────────────────────────────────────────
async function handleMessage(from, msg) {
  console.log(`← 收到消息 from ${from}: ${msg}`);
  const intent = await parseIntent(msg);
  console.log("意图:", JSON.stringify(intent));
  const radars = readRadars();

  switch(intent.action) {

    case "add": {
      const r = {
        id: makeId(intent.label),
        label: intent.label,
        type: intent.type || "search",
        artist: intent.artist || null,
        intent: intent.intent,
        queries: intent.queries || [],
        frequency: intent.frequency || "daily",
        active: true,
        owner: from,
        created_at: new Date().toISOString(),
        last_checked: null,
        last_result: null,
      };
      radars.push(r);
      saveRadars(radars);

      const src = r.type === "concert" ? "Bandsintown（实时演出数据库）" : "网络搜索";
      const freq = { daily:"每天一次", "twice-daily":"每天两次", weekly:"每周一次" }[r.frequency] || "每天一次";

      await sendWA(from,
        `*✓ 已添加监控*\n\n` +
        `*主题:* ${r.label}\n` +
        `*来源:* ${src}\n` +
        `*频率:* ${freq}\n\n` +
        `有新消息直接通知你，没有消息不打扰。`
      );
      break;
    }

    case "list": {
      if (!radars.length) {
        await sendWA(from,
          `*📡 暂无监控*\n\n告诉我你想监控什么：\n\n` +
          `🎵 「监控 Muse 演唱会」\n` +
          `📅 「关注伦敦创业者活动」\n` +
          `📰 「追踪汉坦病毒疫情新闻」`
        );
        break;
      }
      const lines = radars.map((r, i) => {
        const src  = r.type === "concert" ? "🎵 Bandsintown" : "🔍 搜索";
        const freq = { daily:"每天", "twice-daily":"每天两次", weekly:"每周" }[r.frequency] || "每天";
        const last = r.last_result ? new Date(r.last_result).toLocaleDateString("zh-CN") : "暂无";
        return `*${i+1}.* ${r.label}\n${r.active ? "✓ 监控中" : "⏸ 已暂停"} · ${src} · ${freq}\n上次发现: ${last}`;
      });
      await sendWA(from,
        `*📡 我的监控（${radars.length}个）*\n\n${lines.join("\n\n")}\n\n` +
        `_STOP [n] 暂停 · DELETE [n] 删除 · RESUME [n] 恢复_`
      );
      break;
    }

    case "stop": {
      const i = (intent.index || 1) - 1;
      if (i >= 0 && i < radars.length) {
        radars[i].active = false;
        saveRadars(radars);
        await sendWA(from, `⏸ 已暂停：*${radars[i].label}*\n\n发 RESUME ${intent.index} 恢复`);
      } else {
        await sendWA(from, `找不到编号 ${intent.index}，发 LIST 查看列表`);
      }
      break;
    }

    case "resume": {
      const i = (intent.index || 1) - 1;
      if (i >= 0 && i < radars.length) {
        radars[i].active = true;
        saveRadars(radars);
        await sendWA(from, `✓ 已恢复：*${radars[i].label}*`);
      }
      break;
    }

    case "delete": {
      const i = (intent.index || 1) - 1;
      if (i >= 0 && i < radars.length) {
        const label = radars[i].label;
        radars.splice(i, 1);
        saveRadars(radars);
        await sendWA(from, `🗑 已删除：${label}`);
      }
      break;
    }

    default:
      await sendWA(from,
        `*👋 Radar Agent*\n\n` +
        `告诉我你想监控什么，有新消息我会通知你。\n\n` +
        `🎵 「监控 Muse 演唱会」\n` +
        `📅 「关注伦敦创业者活动」\n` +
        `📰 「追踪汉坦病毒疫情」\n` +
        `📦 「监控 Nike 新品发布」\n\n` +
        `_LIST 查看监控 · STOP [n] 暂停 · DELETE [n] 删除_`
      );
  }
}

// ── 主入口 ───────────────────────────────────────────────
async function main() {
  console.log(`Radar Agent 启动 · 模式: ${RUN_MODE}`);

  if (RUN_MODE === "webhook") {
    // 处理单条 WhatsApp 消息
    if (!MSG_FROM || !MSG_TEXT) {
      console.error("webhook 模式缺少 WA_FROM 或 WA_MESSAGE");
      process.exit(1);
    }
    console.log(`处理消息: ${MSG_FROM} → "${MSG_TEXT}"`);
    await handleMessage(MSG_FROM, MSG_TEXT);
    console.log("webhook 处理完成");
  } else {
    // 定时监控模式
    await runMonitorCycle();
  }
}

main().catch(console.error);
