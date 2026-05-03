import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { spawn } from 'child_process';

const CONFIG_PATH = process.env.TRANSLUCID_CONFIG_PATH || '/opt/translucid/config.json';
const CDP_SCRIPT = process.env.CDP_SCRIPT || '/opt/translucid/chrome-cdp-skill/skills/chrome-cdp/scripts/cdp.mjs';
const POLL_MS = Number(process.env.CDP_OBSERVER_POLL_MS || 5000);
const HEALTH_MS = Number(process.env.CDP_OBSERVER_HEALTH_MS || 60000);
const PAGE_SUMMARY_MS = Number(process.env.CDP_OBSERVER_PAGE_SUMMARY_MS || 15000);
const CONTENT_CHANGE_MS = Number(process.env.CDP_OBSERVER_CONTENT_CHANGE_MS || 10000);
const MAX_EVENTS_PER_FLUSH = Number(process.env.CDP_OBSERVER_MAX_EVENTS || 10);

const stateByTab = new Map();
let lastHealthAt = 0;
let configCache = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value ?? '')).digest('hex').slice(0, 16);
}

function limitText(value, max) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function nowIso() {
  return new Date().toISOString();
}

async function readConfig() {
  if (configCache?.sessionId && configCache?.backendUrl) return configCache;
  const raw = await readFile(CONFIG_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  configCache = {
    sessionId: parsed.sessionId,
    backendUrl: String(parsed.backendUrl || '').replace(/\/$/, ''),
  };
  return configCache;
}

function cdpEnv() {
  const env = {
    ...process.env,
    HOME: process.env.HOME || '/home/neko',
    USER: process.env.USER || 'neko',
    CDP_HOST: process.env.CDP_HOST || '127.0.0.1',
  };
  const candidates = [
    '/home/neko/.config/chromium/DevToolsActivePort',
    '/home/neko/.config/chromium/Default/DevToolsActivePort',
  ];
  const found = candidates.find((path) => existsSync(path));
  if (found && !env.CDP_PORT_FILE) env.CDP_PORT_FILE = found;
  return env;
}

function runCdp(args, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [CDP_SCRIPT, ...args], { env: cdpEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`cdp ${args[0]} timeout`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 200000) stdout = stdout.slice(-200000);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error((stderr || stdout || `cdp ${args[0]} exited ${code}`).trim()));
    });
  });
}

function parseList(output) {
  return output.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const parts = line.split(/\s{2,}/).filter(Boolean);
    if (parts.length < 2) return null;
    return {
      id: parts[0].trim(),
      title: limitText(parts.length >= 3 ? parts.slice(1, -1).join(' ') : '', 120),
      url: limitText(parts[parts.length - 1], 500),
    };
  }).filter(Boolean).filter((page) => page.url && !page.url.startsWith('chrome://'));
}

function pageSummaryExpression() {
  return `JSON.stringify((()=>{const clean=s=>String(s||'').replace(/\\s+/g,' ').trim();const text=clean(document.body?.innerText||'').slice(0,2500);const pick=(sel,n=15)=>Array.from(document.querySelectorAll(sel)).filter(el=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0}).slice(0,n).map(el=>clean(el.innerText||el.value||el.getAttribute('aria-label')||el.getAttribute('placeholder')||el.name||el.id||el.href||el.type)).filter(Boolean);return{url:location.href,title:document.title,visibilityState:document.visibilityState,hasFocus:document.hasFocus(),headings:pick('h1,h2,h3',10),buttons:pick('button,[role=button],input[type=button],input[type=submit]',15),inputs:pick('input:not([type=password]):not([type=hidden]),textarea,select,[contenteditable=true]',15),links:pick('a[href]',15),alerts:pick('[role=alert],[aria-live],.error,.success,.alert,.toast,.modal,[role=dialog]',10),visibleTextPreview:text};})())`;
}

async function getPageSummary(tabId) {
  const output = await runCdp(['eval', tabId, pageSummaryExpression()], 15000);
  return JSON.parse(output);
}

function buildEventsForPage(page, summary) {
  const prev = stateByTab.get(page.id) || {};
  const current = {
    url: summary.url || page.url,
    title: summary.title || page.title,
    visibilityState: summary.visibilityState,
    hasFocus: Boolean(summary.hasFocus),
    headings: (summary.headings || []).slice(0, 10),
    buttons: (summary.buttons || []).slice(0, 15),
    inputs: (summary.inputs || []).slice(0, 15),
    links: (summary.links || []).slice(0, 15),
    alerts: (summary.alerts || []).slice(0, 10),
    visibleTextPreview: limitText(summary.visibleTextPreview, 800),
  };
  const time = Date.now();
  const events = [];
  const urlHash = hash(current.url);
  const titleHash = hash(current.title);
  const contentHash = hash(current.visibleTextPreview);
  const interactiveHash = hash({ buttons: current.buttons, inputs: current.inputs, links: current.links, alerts: current.alerts });
  const summaryHash = hash({ url: current.url, title: current.title, headings: current.headings, buttons: current.buttons, inputs: current.inputs, alerts: current.alerts, text: current.visibleTextPreview });

  if (!prev.seen) {
    events.push({ type: 'cdp_tab_state', category: 'browser', message: `CDP tab observed: ${limitText(current.title || current.url, 180)}`, details: current });
  }
  if (prev.urlHash && prev.urlHash !== urlHash) {
    events.push({ type: 'cdp_url_change', category: 'navigation', message: `CDP URL changed: ${limitText(current.title || current.url, 220)}`, details: { tabId: page.id, url: current.url, title: current.title, previousUrl: prev.url } });
  }
  if (prev.titleHash && prev.titleHash !== titleHash) {
    events.push({ type: 'cdp_title_change', category: 'navigation', message: `CDP title changed: ${limitText(current.title, 220)}`, details: { tabId: page.id, url: current.url, title: current.title, previousTitle: prev.title } });
  }
  if (prev.interactiveHash && prev.interactiveHash !== interactiveHash) {
    events.push({ type: 'cdp_interactive_state', category: 'page_context', message: `CDP interactive elements changed on ${limitText(current.title || current.url, 180)}`, details: { tabId: page.id, url: current.url, title: current.title, buttons: current.buttons, inputs: current.inputs, links: current.links, alerts: current.alerts } });
  }
  if ((!prev.summaryHash || prev.summaryHash !== summaryHash) && time - (prev.lastSummaryAt || 0) >= PAGE_SUMMARY_MS) {
    events.push({ type: 'cdp_page_summary', category: 'page_context', message: `CDP page summary: ${limitText(current.title || current.url, 160)}${current.headings.length ? `; headings: ${limitText(current.headings.join(', '), 120)}` : ''}`, details: { ...current, tabId: page.id, hash: summaryHash } });
    prev.lastSummaryAt = time;
  }
  if (prev.contentHash && prev.contentHash !== contentHash && time - (prev.lastContentAt || 0) >= CONTENT_CHANGE_MS) {
    events.push({ type: 'cdp_visible_content_change', category: 'page_context', message: `CDP visible page content changed on ${limitText(current.title || current.url, 180)}`, details: { tabId: page.id, url: current.url, title: current.title, visibleTextPreview: current.visibleTextPreview, hash: contentHash } });
    prev.lastContentAt = time;
  }

  stateByTab.set(page.id, { ...prev, seen: true, url: current.url, title: current.title, urlHash, titleHash, contentHash, interactiveHash, summaryHash, lastSeenAt: time });
  return events;
}

async function postEvents(events) {
  if (!events.length) return;
  const { sessionId, backendUrl } = await readConfig();
  if (!sessionId || !backendUrl) throw new Error('missing sessionId/backendUrl');
  const url = `${backendUrl}/api/dashboard/sessions/${sessionId}/browser-cdp-activity`;
  const body = { events: events.slice(0, MAX_EVENTS_PER_FLUSH).map((event) => ({ ...event, timestamp: nowIso(), skill_version: '1.0.2' })) };
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`backend ${response.status}: ${await response.text()}`);
}

async function observeOnce() {
  const events = [];
  const listOutput = await runCdp(['list'], 10000);
  const pages = parseList(listOutput).slice(0, 8);
  const importantPages = pages.filter((page, index) => index === 0 || !page.url.startsWith('about:')).slice(0, 3);
  for (const page of importantPages) {
    try {
      const summary = await getPageSummary(page.id);
      events.push(...buildEventsForPage(page, summary));
    } catch (error) {
      events.push({ type: 'cdp_error', category: 'health', message: `CDP page inspect failed: ${limitText(error.message, 220)}`, details: { tabId: page.id, url: page.url, title: page.title } });
    }
  }
  if (Date.now() - lastHealthAt >= HEALTH_MS) {
    events.push({ type: 'cdp_health', category: 'health', message: `CDP observer healthy: ${pages.length} tab(s) visible`, details: { tabCount: pages.length, inspectedCount: importantPages.length } });
    lastHealthAt = Date.now();
  }
  await postEvents(events);
}

async function main() {
  console.log(`[cdp-observer] starting with ${CDP_SCRIPT}`);
  for (;;) {
    try {
      await observeOnce();
    } catch (error) {
      console.error(`[cdp-observer] ${error.message}`);
      try {
        await postEvents([{ type: 'cdp_error', category: 'health', message: `CDP observer error: ${limitText(error.message, 220)}`, details: { phase: 'observe' } }]);
      } catch {}
    }
    await sleep(POLL_MS);
  }
}

main().catch((error) => {
  console.error(`[cdp-observer] fatal: ${error.message}`);
  process.exit(1);
});
