// radar-agent/agent/index.js
// Radar Agent — personal monitoring with WhatsApp delivery
// Node.js 18+ required

import Anthropic from "@anthropic-ai/sdk";
import twilio from "twilio";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "../data");

// ── CONFIG ──────────────────────────────────────────────
const CONFIG = {
  whatsapp_to: process.env.WHATSAPP_TO,      // "whatsapp:+447700000000"
  whatsapp_from: process.env.WHATSAPP_FROM,  // "whatsapp:+14155238886" (Twilio sandbox)
  twilio_sid: process.env.TWILIO_SID,
  twilio_token: process.env.TWILIO_TOKEN,
  anthropic_key: process.env.ANTHROPIC_API_KEY,
  max_results_per_radar: 3,
  search_model: "claude-sonnet-4-6",
};

// ── CLIENTS ─────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: CONFIG.anthropic_key });
const twilioClient = twilio(CONFIG.twilio_sid, CONFIG.twilio_token);

// ── DATA HELPERS ────────────────────────────────────────
function dataPath(file) {
  return join(DATA_DIR, file);
}

function readJSON(file, fallback = []) {
  const p = dataPath(file);
  if (!existsSync(p)) return fallback;
  try { return JSON.parse(readFileSync(p, "utf8")); }
  catch { return fallback; }
}

function writeJSON(file, data) {
  writeFileSync(dataPath(file), JSON.stringify(data, null, 2));
}

// ── SEARCH ──────────────────────────────────────────────
async function searchWeb(query) {
  const response = await anthropic.messages.create({
    model: CONFIG.search_model,
    max_tokens: 1000,
    tools: [{ type: "web_search_20250305", name: "web_search" }],
    messages: [{ role: "user", content: `Search for: ${query}\n\nReturn the top 5 results with title, URL, and a brief description of what each page contains.` }],
  });

  return response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

// ── SOURCE DISCOVERY ─────────────────────────────────────
// Run 3 discovery searches for a new radar topic, then ask Claude
// to evaluate and pick the best official/structured sources found.
async function discoverSources(topic) {
  console.log(`  Discovering sources for: "${topic}"`);

  const queries = [
    `${topic} RSS feed official`,
    `${topic} API free`,
    `${topic} WHO CDC official site`,
  ];

  let combined = "";
  for (const q of queries) {
    console.log(`    → ${q}`);
    try {
      const result = await searchWeb(q);
      combined += `\n\n--- Query: ${q} ---\n${result}`;
      await new Promise((r) => setTimeout(r, 800));
    } catch (err) {
      console.error(`    Search failed: ${err.message}`);
    }
  }

  if (!combined) return [];

  const prompt = `You are helping set up a personal monitoring radar for the topic: "${topic}".

The following web searches were run to find official or structured data sources (RSS feeds, APIs, official sites):
${combined}

From these results, extract up to 4 of the most useful sources for monitoring this topic. Prefer:
1. Official RSS / Atom feeds
2. Free public APIs
3. Official authoritative websites (WHO, CDC, gov sites, official artist/event pages)
4. Reliable aggregator sites with structured data

For each source return:
- name (string) — short human-readable name
- url (string) — direct URL to the feed, API endpoint, or site
- type (string) — one of: "rss", "api", "official_site", "aggregator"
- description (string) — one sentence on what this source provides

Return ONLY a raw JSON array (no markdown fences). Empty array [] if nothing useful found.
Example: [{"name":"Ticketmaster Muse","url":"https://...","type":"aggregator","description":"Ticketmaster listings for Muse events."}]`;

  const response = await anthropic.messages.create({
    model: CONFIG.search_model,
    max_tokens: 1000,
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.content.find((b) => b.type === "text")?.text || "[]";
  const sources = repairJsonArray(text);
  console.log(`  Found ${sources.length} source(s)`);
  return sources;
}

// ── ADD RADAR (with source discovery) ────────────────────
async function addRadar(draft) {
  console.log(`\n→ Adding radar: ${draft.label}`);

  // Run source discovery before saving
  const sources = await discoverSources(draft.label);

  const radar = {
    ...draft,
    sources,                         // attach discovered sources
    created_at: new Date().toISOString(),
    last_checked: null,
    last_result: null,
  };

  const radars = readJSON("radars.json");
  radars.push(radar);
  writeJSON("radars.json", radars);
  console.log(`  Saved to radars.json`);

  // Send WhatsApp confirmation
  const msg = formatConfirmationMessage(radar);
  await sendWhatsApp(msg);

  return radar;
}

// ── EVALUATE RESULTS ────────────────────────────────────

// Extracts complete JSON objects from a possibly-truncated array string.
function repairJsonArray(text) {
  const clean = text.replace(/```json|```/g, "").trim();

  try {
    const parsed = JSON.parse(clean);
    if (Array.isArray(parsed)) return parsed;
  } catch {}

  const start = clean.indexOf("[");
  if (start === -1) return [];

  const items = [];
  let depth = 0;
  let objStart = -1;

  for (let i = start + 1; i < clean.length; i++) {
    const ch = clean[i];
    if (ch === "{") {
      if (depth === 0) objStart = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && objStart !== -1) {
        const chunk = clean.slice(objStart, i + 1);
        try { items.push(JSON.parse(chunk)); } catch {}
        objStart = -1;
      }
    }
  }

  return items;
}

async function evaluateResults(radar, searchResults, seenUrls) {
  const prompt = `You are evaluating search results for a personal monitoring radar.

Radar intent: ${radar.intent}

Search results:
${searchResults}

Previously seen URLs (skip these):
${seenUrls.join("\n") || "none"}

Tasks:
1. Filter out results that don't match the intent
2. Filter out URLs already in the "previously seen" list
3. Filter out results that are clearly old (more than 6 months ago unless they announce future events)
4. Return AT MOST 3 of the most relevant results. For each, extract:
   - title (string)
   - url (string)
   - date (string or null — the event date, not the article date)
   - location (string or null)
   - summary (one sentence, in the same language as the intent)

Return ONLY a raw JSON array (no markdown fences, no explanation). Empty array [] if nothing relevant.
Example: [{"title":"Muse London O2 2026","url":"https://...","date":"2026-03-15","location":"London O2 Arena","summary":"Muse announced a London show at O2 Arena on March 15 2026."}]`;

  const response = await anthropic.messages.create({
    model: CONFIG.search_model,
    max_tokens: 1500,
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.content.find((b) => b.type === "text")?.text || "[]";
  const items = repairJsonArray(text);
  if (items.length === 0 && text.trim() !== "[]") {
    console.error("Failed to parse evaluation response:", text.slice(0, 300));
  }
  return items;
}

// ── WHATSAPP DELIVERY ────────────────────────────────────
async function sendWhatsApp(message) {
  try {
    await twilioClient.messages.create({
      from: CONFIG.whatsapp_from,
      to: CONFIG.whatsapp_to,
      body: message,
    });
    console.log("✓ WhatsApp sent");
    return true;
  } catch (err) {
    console.error("WhatsApp send failed:", err.message);
    return false;
  }
}

// ── FORMATTING HELPERS ───────────────────────────────────

function frequencyLabel(f) {
  switch (f) {
    case "twice-daily": return "每天两次";
    case "daily":       return "每天";
    case "weekly":      return "每周";
    default:            return f;
  }
}

function formatDate(iso) {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleDateString("zh-CN", {
      year: "numeric", month: "long", day: "numeric",
    });
  } catch { return iso; }
}

// 1. Single result
// 2. Multiple results
function formatWhatsAppMessage(radar, results) {
  const footer = `---\n_发 LIST 管理 · STOP [n] 暂停_`;

  if (results.length === 1) {
    const r = results[0];
    const meta = [
      r.date     ? `📅 ${r.date}` : null,
      r.location ? `📍 ${r.location}` : null,
    ].filter(Boolean).join("\n");

    return [
      `*🎯 ${radar.label}*`,
      ``,
      r.summary,
      meta || null,
      `🔗 ${r.url}`,
      ``,
      `_来源: 网络搜索 · ${frequencyLabel(radar.frequency)}_`,
      footer,
    ].filter((l) => l !== null).join("\n");
  }

  const lines = [
    `*🎯 ${radar.label} · ${results.length}条新消息*`,
    ``,
  ];

  results.forEach((r, i) => {
    lines.push(`*${i + 1}.* ${r.title}`);
    lines.push(r.summary);
    const meta = [
      r.date     ? `📅 ${r.date}` : null,
      r.location ? `📍 ${r.location}` : null,
    ].filter(Boolean).join(" · ");
    if (meta) lines.push(meta);
    lines.push(`🔗 ${r.url}`);
    if (i < results.length - 1) lines.push(``);
  });

  lines.push(``, footer);
  return lines.join("\n");
}

// 3. LIST command response
function formatListMessage(radars) {
  const lines = [`*📡 你的监控列表*`, ``];

  radars.forEach((r, i) => {
    const status = r.active ? "✅ 监控中" : "⏸ 已暂停";
    const lastFound = r.last_result ? formatDate(r.last_result) : "暂无";
    lines.push(`*${i + 1}.* ${r.label}`);
    lines.push(`${status} · 网络搜索 · ${frequencyLabel(r.frequency)}`);
    lines.push(`上次发现: ${lastFound}`);
    if (i < radars.length - 1) lines.push(``);
  });

  lines.push(``, `---`, `_STOP [n] 暂停 · DELETE [n] 删除 · RESUME [n] 恢复_`);
  return lines.join("\n");
}

// 4. New radar confirmation (includes discovered sources if any)
function formatConfirmationMessage(radar) {
  const lines = [
    `*✓ 已添加监控*`,
    ``,
    `*主题:* ${radar.label}`,
    `*来源:* 网络搜索`,
    `*频率:* ${frequencyLabel(radar.frequency)}`,
  ];

  if (radar.sources && radar.sources.length > 0) {
    lines.push(``, `*发现的数据源:*`);
    radar.sources.slice(0, 3).forEach((s) => {
      const typeIcon = { rss: "📡", api: "⚙️", official_site: "🏛", aggregator: "🔗" }[s.type] || "🔗";
      lines.push(`${typeIcon} ${s.name}`);
    });
  }

  lines.push(``, `有新消息直接通知你，没有消息不打扰。`);
  return lines.join("\n");
}

// ── RUN ONE RADAR ────────────────────────────────────────
async function runRadar(radar) {
  console.log(`\n→ Running radar: ${radar.label}`);

  const allResults = readJSON("results.json");
  const seenUrls = allResults
    .filter((r) => r.radar_id === radar.id && r.notified)
    .map((r) => r.url);

  let allSearchText = "";
  for (const query of radar.queries) {
    console.log(`  Searching: ${query}`);
    try {
      const result = await searchWeb(query);
      allSearchText += `\n\n--- Query: ${query} ---\n${result}`;
      await new Promise((r) => setTimeout(r, 1000));
    } catch (err) {
      console.error(`  Search failed: ${err.message}`);
    }
  }

  if (!allSearchText) {
    console.log("  No search results");
    return;
  }

  console.log(`  Evaluating results…`);
  const newResults = await evaluateResults(radar, allSearchText, seenUrls);
  console.log(`  Found ${newResults.length} new relevant results`);

  if (newResults.length === 0) {
    updateRadarChecked(radar.id);
    return;
  }

  const toNotify = newResults.slice(0, CONFIG.max_results_per_radar);
  const message = formatWhatsAppMessage(radar, toNotify);
  const sent = await sendWhatsApp(message);

  const now = new Date().toISOString();
  const savedResults = readJSON("results.json");

  for (const r of toNotify) {
    savedResults.push({
      radar_id: radar.id,
      found_at: now,
      title: r.title,
      url: r.url,
      date: r.date || null,
      location: r.location || null,
      summary: r.summary,
      notified: sent,
    });
  }

  writeJSON("results.json", savedResults);
  updateRadarChecked(radar.id, now);
  console.log(`  ✓ Done — notified: ${sent}`);
}

function updateRadarChecked(radarId, lastResult = null) {
  const radars = readJSON("radars.json");
  const idx = radars.findIndex((r) => r.id === radarId);
  if (idx === -1) return;
  radars[idx].last_checked = new Date().toISOString();
  if (lastResult) radars[idx].last_result = lastResult;
  writeJSON("radars.json", radars);
}

// ── FREQUENCY CHECK ──────────────────────────────────────
function shouldRunNow(radar) {
  if (!radar.active) return false;
  if (!radar.last_checked) return true;

  const hoursSince = (Date.now() - new Date(radar.last_checked)) / 1000 / 60 / 60;

  switch (radar.frequency) {
    case "twice-daily": return hoursSince >= 12;
    case "daily":       return hoursSince >= 24;
    case "weekly":      return hoursSince >= 168;
    default:            return hoursSince >= 24;
  }
}

// ── MAIN ────────────────────────────────────────────────
async function main() {
  console.log("Radar Agent starting…");
  console.log(`Time: ${new Date().toISOString()}`);

  const radars = readJSON("radars.json");
  const active = radars.filter((r) => r.active);
  console.log(`Active radars: ${active.length}`);

  if (active.length === 0) {
    console.log("No active radars. Add some in data/radars.json");
    return;
  }

  for (const radar of active) {
    if (shouldRunNow(radar)) {
      await runRadar(radar);
      await new Promise((r) => setTimeout(r, 2000));
    } else {
      console.log(`→ Skipping ${radar.label} (not due yet)`);
    }
  }

  console.log("\nRadar Agent complete.");
}

main().catch(console.error);

// ── EXPORTS (for use by other modules / CLI) ─────────────
export { addRadar, discoverSources, formatListMessage, formatConfirmationMessage };
