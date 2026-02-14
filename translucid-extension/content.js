'use strict';

/**
 * Translucid VM Activity Tracker — Content Script
 * 
 * Injected into every page inside the VM browser. Tracks:
 * - Text input in form fields, textareas, contenteditable elements
 * - Clipboard copy/paste events
 * - Form submissions
 * 
 * Text input is debounced — only sent after user stops typing for 2 seconds.
 * Password fields are NEVER logged (privacy).
 * 
 * Compatible with: Chromium and Firefox via WebExtensions API.
 */

// ============================================================================
// TEXT INPUT TRACKING — Debounced per-field tracking
// ============================================================================

const INPUT_DEBOUNCE_MS = 2000;
const activeInputs = new Map(); // fieldKey -> { timer, text, fieldType, fieldName }

function getFieldKey(el) {
  // Create a unique key for this input field
  const tag = el.tagName.toLowerCase();
  const name = el.name || el.id || el.getAttribute('aria-label') || '';
  const type = el.type || 'text';
  const path = getElementPath(el);
  return `${tag}:${type}:${name}:${path}`;
}

function getElementPath(el) {
  // Simple CSS-like path for identification
  const parts = [];
  let current = el;
  for (let i = 0; i < 3 && current && current !== document.body; i++) {
    let part = current.tagName.toLowerCase();
    if (current.id) part += '#' + current.id;
    else if (current.className && typeof current.className === 'string') {
      const cls = current.className.trim().split(/\s+/)[0];
      if (cls) part += '.' + cls;
    }
    parts.unshift(part);
    current = current.parentElement;
  }
  return parts.join(' > ');
}

function getFieldLabel(el) {
  // Try to find a human-readable label for this field
  if (el.placeholder) return el.placeholder;
  if (el.name) return el.name;
  if (el.id) {
    const label = document.querySelector(`label[for="${el.id}"]`);
    if (label) return label.textContent.trim().substring(0, 50);
    return el.id;
  }
  if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
  return el.tagName.toLowerCase();
}

function handleTextInput(el) {
  // NEVER log password fields
  if (el.type === 'password') return;

  const fieldKey = getFieldKey(el);
  const text = el.value || el.textContent || '';

  // Skip empty input
  if (!text.trim()) return;

  // Clear existing debounce timer for this field
  const existing = activeInputs.get(fieldKey);
  if (existing && existing.timer) {
    clearTimeout(existing.timer);
  }

  // Set new debounce timer
  const timer = setTimeout(() => {
    const finalText = el.value || el.textContent || '';
    if (finalText.trim()) {
      sendToBackground('text_input', {
        text: finalText.trim(),
        fieldType: el.type || (el.tagName === 'TEXTAREA' ? 'textarea' : 'contenteditable'),
        fieldName: getFieldLabel(el),
      });
    }
    activeInputs.delete(fieldKey);
  }, INPUT_DEBOUNCE_MS);

  activeInputs.set(fieldKey, {
    timer,
    text,
    fieldType: el.type || 'text',
    fieldName: getFieldLabel(el),
  });
}

// Listen for input events on the document (captures all fields via delegation)
document.addEventListener('input', (e) => {
  const el = e.target;
  if (!el) return;

  const tag = el.tagName;
  if (!tag) return;

  const tagLower = tag.toLowerCase();

  // Track input, textarea, and contenteditable elements
  if (tagLower === 'input' || tagLower === 'textarea') {
    // Skip non-text input types
    const skipTypes = ['checkbox', 'radio', 'range', 'color', 'file', 'hidden', 'submit', 'button', 'reset', 'image'];
    if (el.type && skipTypes.includes(el.type)) return;
    handleTextInput(el);
  } else if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') {
    handleTextInput(el);
  }
}, true);

// ============================================================================
// CLIPBOARD TRACKING — Copy and paste events
// ============================================================================

document.addEventListener('copy', (e) => {
  // Get selected text
  const selection = window.getSelection();
  const text = selection ? selection.toString() : '';

  sendToBackground('clipboard_copy', {
    text: text.substring(0, 500), // Limit to 500 chars
    textLength: text.length,
  });
});

document.addEventListener('paste', (e) => {
  let text = '';
  if (e.clipboardData) {
    text = e.clipboardData.getData('text/plain') || '';
  }

  sendToBackground('clipboard_paste', {
    text: text.substring(0, 500),
    textLength: text.length,
  });
});

// ============================================================================
// FORM SUBMISSION TRACKING
// ============================================================================

document.addEventListener('submit', (e) => {
  const form = e.target;
  if (!form || form.tagName?.toLowerCase() !== 'form') return;

  const action = form.action || window.location.href;
  const method = (form.method || 'GET').toUpperCase();

  sendToBackground('page_interaction', {
    message: `Form submitted on ${window.location.hostname}`,
    details: {
      action: action,
      method: method,
      formId: form.id || '',
      formName: form.name || '',
      fieldCount: form.elements?.length || 0,
    },
  });
}, true);

// ============================================================================
// MESSAGING — Send events to background service worker
// ============================================================================

function sendToBackground(type, data) {
  try {
    // Use chrome.runtime for Chromium, browser.runtime for Firefox
    const runtime = typeof chrome !== 'undefined' ? chrome.runtime : 
                    typeof browser !== 'undefined' ? browser.runtime : null;
    
    if (runtime && runtime.sendMessage) {
      runtime.sendMessage({ type, ...data }, () => {
        // Ignore response errors (extension context may be invalidated)
        if (typeof chrome !== 'undefined' && chrome.runtime?.lastError) {
          // Silently ignore — extension may have been reloaded
        }
      });
    }
  } catch (e) {
    // Extension context invalidated — page outlived the extension
  }
}

// ============================================================================
// INITIALIZATION
// ============================================================================

// Don't log anything on internal browser pages
if (!window.location.href.startsWith('chrome://') && 
    !window.location.href.startsWith('chrome-extension://') &&
    !window.location.href.startsWith('about:') &&
    !window.location.href.startsWith('moz-extension://')) {
  // Content script loaded — no visible indication to user
}
