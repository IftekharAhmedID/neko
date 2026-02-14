'use strict';

/**
 * Translucid VM Activity Tracker — Background Service Worker
 * 
 * Tracks all user activity inside the VM browser:
 * - Tab creation, closure, switching
 * - URL navigation and page loads
 * - Search queries (detected from URL patterns)
 * - Downloads
 * - Window focus changes
 * - Text input (received from content script)
 * 
 * Events are batched and sent to the Translucid backend every 5 seconds.
 * Failed batches are queued for retry with exponential backoff.
 * 
 * Compatible with: Chromium (Manifest V3), Firefox (via manifest.v2.json)
 */

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG_URL = 'http://127.0.0.1:3200/config.json';
const BATCH_INTERVAL_MS = 5000;
const MAX_QUEUE_SIZE = 500;
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 2000;

let config = {
  sessionId: null,
  backendUrl: null,
  enabled: false,
};

// ============================================================================
// EVENT QUEUE — Batches events and sends periodically
// ============================================================================

const eventQueue = [];
let batchTimer = null;
let retryCount = 0;

function queueEvent(event) {
  if (!config.enabled || !config.sessionId) return;

  eventQueue.push({
    ...event,
    timestamp: new Date().toISOString(),
    source: 'vm_extension',
  });

  // Trim queue if it gets too large (keep newest)
  if (eventQueue.length > MAX_QUEUE_SIZE) {
    eventQueue.splice(0, eventQueue.length - MAX_QUEUE_SIZE);
  }
}

async function flushEvents() {
  if (eventQueue.length === 0 || !config.sessionId || !config.backendUrl) return;

  // Take all events from queue
  const batch = eventQueue.splice(0, eventQueue.length);

  try {
    const response = await fetch(
      `${config.backendUrl}/api/dashboard/sessions/${config.sessionId}/vm-activity`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events: batch }),
      }
    );

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    retryCount = 0;
  } catch (err) {
    console.warn('[Translucid] Flush failed, re-queuing', err.message);
    // Re-queue events at the front
    eventQueue.unshift(...batch);
    retryCount++;

    if (retryCount > MAX_RETRY_ATTEMPTS) {
      // Drop oldest events to prevent unbounded growth
      const dropCount = Math.min(batch.length, Math.floor(MAX_QUEUE_SIZE / 2));
      eventQueue.splice(0, dropCount);
      console.warn(`[Translucid] Dropped ${dropCount} events after ${MAX_RETRY_ATTEMPTS} retries`);
      retryCount = 0;
    }
  }
}

function startBatchTimer() {
  if (batchTimer) return;
  batchTimer = setInterval(flushEvents, BATCH_INTERVAL_MS);
}

function stopBatchTimer() {
  if (batchTimer) {
    clearInterval(batchTimer);
    batchTimer = null;
  }
}

// ============================================================================
// CONFIG LOADING — Reads session config from local config server
// ============================================================================

async function loadConfig() {
  // Attempt 1: Local config server (set up by VM startup script)
  try {
    const resp = await fetch(CONFIG_URL);
    if (resp.ok) {
      const data = await resp.json();
      if (data.sessionId && data.backendUrl) {
        config.sessionId = data.sessionId;
        config.backendUrl = data.backendUrl;
        config.enabled = true;
        console.log('[Translucid] Config loaded from local server:', config.sessionId);
        startBatchTimer();
        return;
      }
    }
  } catch (e) {
    console.warn('[Translucid] Local config server not available:', e.message);
  }

  // Attempt 2: Chrome managed storage (policy-based config)
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.managed) {
      const data = await chrome.storage.managed.get(['sessionId', 'backendUrl']);
      if (data.sessionId && data.backendUrl) {
        config.sessionId = data.sessionId;
        config.backendUrl = data.backendUrl;
        config.enabled = true;
        console.log('[Translucid] Config loaded from managed storage:', config.sessionId);
        startBatchTimer();
        return;
      }
    }
  } catch (e) {
    // Managed storage not available
  }

  // Attempt 3: Extension local storage (set during installation)
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      const data = await chrome.storage.local.get(['sessionId', 'backendUrl']);
      if (data.sessionId && data.backendUrl) {
        config.sessionId = data.sessionId;
        config.backendUrl = data.backendUrl;
        config.enabled = true;
        console.log('[Translucid] Config loaded from local storage:', config.sessionId);
        startBatchTimer();
        return;
      }
    }
  } catch (e) {
    // Local storage not available
  }

  // Config not found — retry in 10 seconds
  console.warn('[Translucid] No config found, retrying in 10s...');
  setTimeout(loadConfig, 10000);
}

// ============================================================================
// SEARCH QUERY DETECTION — Extracts search terms from known search engines
// ============================================================================

const SEARCH_PATTERNS = [
  { host: 'google.com',     param: 'q' },
  { host: 'www.google.com', param: 'q' },
  { host: 'bing.com',       param: 'q' },
  { host: 'www.bing.com',   param: 'q' },
  { host: 'duckduckgo.com', param: 'q' },
  { host: 'search.yahoo.com', param: 'p' },
  { host: 'www.ecosia.org', param: 'q' },
  { host: 'www.startpage.com', param: 'query' },
];

function extractSearchQuery(url) {
  try {
    const parsed = new URL(url);
    for (const pattern of SEARCH_PATTERNS) {
      if (parsed.hostname === pattern.host || parsed.hostname.endsWith('.' + pattern.host)) {
        const query = parsed.searchParams.get(pattern.param);
        if (query && query.trim().length > 0) {
          return { engine: pattern.host.replace('www.', ''), query: query.trim() };
        }
      }
    }
  } catch (e) {
    // Invalid URL
  }
  return null;
}

// ============================================================================
// DOMAIN EXTRACTION — Clean domain from URL for readable logging
// ============================================================================

function getDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function getReadableUrl(url) {
  try {
    const parsed = new URL(url);
    // Remove tracking params for cleaner logging
    return `${parsed.hostname}${parsed.pathname}`.replace(/\/$/, '');
  } catch {
    return url;
  }
}

// ============================================================================
// TAB TRACKING — Monitors tab lifecycle and navigation
// ============================================================================

// Track known tab URLs to detect actual navigation changes
const tabUrls = new Map();
const tabTitles = new Map();

// Tab created
chrome.tabs.onCreated.addListener((tab) => {
  queueEvent({
    type: 'tab_created',
    category: 'navigation',
    message: 'New tab opened',
    details: {
      tabId: tab.id,
      url: tab.pendingUrl || tab.url || 'about:blank',
    },
  });
});

// Tab closed
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  const lastUrl = tabUrls.get(tabId) || 'unknown';
  const lastTitle = tabTitles.get(tabId) || '';
  tabUrls.delete(tabId);
  tabTitles.delete(tabId);

  queueEvent({
    type: 'tab_closed',
    category: 'navigation',
    message: `Closed tab: ${lastTitle || getDomain(lastUrl)}`,
    details: {
      tabId,
      url: lastUrl,
      title: lastTitle,
      windowClosing: removeInfo.isWindowClosing,
    },
  });
});

// Tab updated (URL change, title change, loading complete)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Track URL changes (actual navigation)
  if (changeInfo.url) {
    const prevUrl = tabUrls.get(tabId);
    tabUrls.set(tabId, changeInfo.url);

    // Skip internal browser pages
    if (changeInfo.url.startsWith('chrome://') || changeInfo.url.startsWith('about:')) return;

    // Check for search query
    const search = extractSearchQuery(changeInfo.url);
    if (search) {
      queueEvent({
        type: 'search_query',
        category: 'search',
        message: `Searched on ${search.engine}: "${search.query}"`,
        details: {
          tabId,
          engine: search.engine,
          query: search.query,
          url: changeInfo.url,
        },
      });
    }

    // Log navigation
    queueEvent({
      type: 'navigation',
      category: 'navigation',
      message: `Navigated to ${getReadableUrl(changeInfo.url)}`,
      details: {
        tabId,
        url: changeInfo.url,
        previousUrl: prevUrl || null,
        domain: getDomain(changeInfo.url),
      },
    });
  }

  // Track title changes
  if (changeInfo.title) {
    tabTitles.set(tabId, changeInfo.title);
  }

  // Page finished loading
  if (changeInfo.status === 'complete' && tab.url) {
    // Skip internal pages
    if (tab.url.startsWith('chrome://') || tab.url.startsWith('about:')) return;

    tabUrls.set(tabId, tab.url);
    tabTitles.set(tabId, tab.title || '');

    queueEvent({
      type: 'page_loaded',
      category: 'navigation',
      message: `Page loaded: ${tab.title || getDomain(tab.url)}`,
      details: {
        tabId,
        url: tab.url,
        title: tab.title || '',
        domain: getDomain(tab.url),
      },
    });
  }
});

// Tab activated (user switched to a different tab)
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('about:')) {
      queueEvent({
        type: 'tab_switched',
        category: 'navigation',
        message: `Switched to tab: ${tab.title || getDomain(tab.url)}`,
        details: {
          tabId: tab.id,
          url: tab.url,
          title: tab.title || '',
          domain: getDomain(tab.url),
        },
      });
    }
  } catch (e) {
    // Tab may have been closed
  }
});

// ============================================================================
// DOWNLOAD TRACKING
// ============================================================================

if (chrome.downloads) {
  chrome.downloads.onCreated.addListener((downloadItem) => {
    queueEvent({
      type: 'download_started',
      category: 'download',
      message: `Download started: ${downloadItem.filename || downloadItem.url}`,
      details: {
        url: downloadItem.url,
        filename: downloadItem.filename || '',
        fileSize: downloadItem.fileSize || 0,
        mime: downloadItem.mime || '',
      },
    });
  });

  chrome.downloads.onChanged.addListener((delta) => {
    if (delta.state && delta.state.current === 'complete') {
      queueEvent({
        type: 'download_complete',
        category: 'download',
        message: `Download completed`,
        details: {
          downloadId: delta.id,
        },
      });
    }
  });
}

// ============================================================================
// WINDOW FOCUS TRACKING
// ============================================================================

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    queueEvent({
      type: 'window_blur',
      category: 'focus',
      message: 'Browser lost focus',
      details: {},
    });
  } else {
    queueEvent({
      type: 'window_focus',
      category: 'focus',
      message: 'Browser gained focus',
      details: { windowId },
    });
  }
});

// ============================================================================
// WEB NAVIGATION — Detailed navigation tracking
// ============================================================================

if (chrome.webNavigation) {
  // Detect form submissions (POST navigations)
  chrome.webNavigation.onBeforeNavigate.addListener((details) => {
    // Only track main frame
    if (details.frameId !== 0) return;
    if (details.url.startsWith('chrome://') || details.url.startsWith('about:')) return;

    // We don't log here — onUpdated handles the actual navigation
    // This is used for detecting the transition type
  });

  chrome.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId !== 0) return;
    if (details.url.startsWith('chrome://') || details.url.startsWith('about:')) return;

    // Log transition type for context (typed URL, link click, form submit, etc.)
    if (details.transitionType === 'typed') {
      queueEvent({
        type: 'url_typed',
        category: 'navigation',
        message: `User typed URL: ${getReadableUrl(details.url)}`,
        details: {
          tabId: details.tabId,
          url: details.url,
          domain: getDomain(details.url),
          transitionType: details.transitionType,
        },
      });
    } else if (details.transitionType === 'form_submit') {
      queueEvent({
        type: 'form_submitted',
        category: 'input',
        message: `Form submitted on ${getDomain(details.url)}`,
        details: {
          tabId: details.tabId,
          url: details.url,
          domain: getDomain(details.url),
        },
      });
    }
  });
}

// ============================================================================
// CONTENT SCRIPT MESSAGE HANDLER — Receives text input events from pages
// ============================================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!config.enabled) {
    sendResponse({ ok: false });
    return;
  }

  switch (message.type) {
    case 'text_input':
      queueEvent({
        type: 'text_input',
        category: 'input',
        message: `User typed: "${truncate(message.text, 200)}"`,
        details: {
          tabId: sender.tab?.id,
          url: sender.tab?.url || '',
          domain: getDomain(sender.tab?.url || ''),
          pageTitle: sender.tab?.title || '',
          fieldType: message.fieldType || 'text',
          fieldName: message.fieldName || '',
          text: message.text,
          textLength: message.text?.length || 0,
        },
      });
      break;

    case 'clipboard_copy':
      queueEvent({
        type: 'clipboard_copy',
        category: 'input',
        message: `User copied text (${message.textLength} chars)`,
        details: {
          tabId: sender.tab?.id,
          url: sender.tab?.url || '',
          domain: getDomain(sender.tab?.url || ''),
          textLength: message.textLength || 0,
          textPreview: truncate(message.text || '', 100),
        },
      });
      break;

    case 'clipboard_paste':
      queueEvent({
        type: 'clipboard_paste',
        category: 'input',
        message: `User pasted text (${message.textLength} chars)`,
        details: {
          tabId: sender.tab?.id,
          url: sender.tab?.url || '',
          domain: getDomain(sender.tab?.url || ''),
          textLength: message.textLength || 0,
          textPreview: truncate(message.text || '', 100),
        },
      });
      break;

    case 'page_interaction':
      queueEvent({
        type: 'page_interaction',
        category: 'interaction',
        message: message.message || 'Page interaction',
        details: {
          tabId: sender.tab?.id,
          url: sender.tab?.url || '',
          domain: getDomain(sender.tab?.url || ''),
          ...message.details,
        },
      });
      break;
  }

  sendResponse({ ok: true });
});

// ============================================================================
// UTILITIES
// ============================================================================

function truncate(str, maxLen) {
  if (!str) return '';
  return str.length > maxLen ? str.substring(0, maxLen) + '...' : str;
}

// ============================================================================
// INITIALIZATION
// ============================================================================

console.log('[Translucid] VM Activity Tracker starting...');
loadConfig();

// Flush remaining events before the service worker terminates
if (typeof self !== 'undefined' && self.addEventListener) {
  self.addEventListener('activate', () => {
    console.log('[Translucid] Service worker activated');
  });
}

// Periodic config reload (in case config server starts after extension)
setInterval(() => {
  if (!config.enabled) {
    loadConfig();
  }
}, 30000);
