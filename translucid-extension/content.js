'use strict';

const INPUT_DEBOUNCE_MS = 2200;
const CODE_INPUT_DEBOUNCE_MS = 12000;
const MAX_TEXT_PREVIEW = 260;
const MAX_TEXT_CAPTURE = 1200;
const CLICK_THROTTLE_MS = 900;
const SELECTION_THROTTLE_MS = 3000;
const OUTPUT_THROTTLE_MS = 3000;
const OUTPUT_CORRELATION_MS = 8000;
const INPUT_MAX_AGE_MS = 8000;
const MEDIA_DEDUPE_MS = 4500;
const MEDIA_USER_WINDOW_MS = 6000;
const OUTPUT_DEDUPE_MS = 20000;
const TERMINAL_OUTPUT_THROTTLE_MS = 4000;

const activeInputs = new Map();
const valueSnapshots = new WeakMap();
const emittedInputHashes = new WeakMap();
const recentBeforeInputAt = new WeakMap();
const recentClicks = new Map();
const recentClipboard = new Map();
const mediaStates = new WeakMap();
const recentMediaEvents = new Map();
const recentOutputs = new Map();
const recentTerminalOutputs = new Map();

let lastSelectionAt = 0;
let lastOutputAt = 0;
let lastActionAt = 0;
let lastActionLabel = '';
let recentUserGestureAt = 0;
let recentMediaGestureAt = 0;
let lastTerminalOutputAt = 0;
const pageStartedAt = Date.now();

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function truncate(value, max = MAX_TEXT_PREVIEW) {
  const text = normalizeText(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function textHash(value) {
  const text = String(value || '');
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return `${text.length}:${hash}`;
}

function pruneRecentMap(map, maxAgeMs) {
  const now = Date.now();
  for (const [key, seenAt] of map.entries()) {
    if (now - seenAt > maxAgeMs) map.delete(key);
  }
}

function rawLimit(value, max = MAX_TEXT_CAPTURE) {
  const text = String(value || '');
  return text.length > max ? text.slice(0, max) : text;
}

function countLines(value) {
  const text = String(value || '');
  if (!text) return 0;
  return text.split(/\r\n|\r|\n/).length;
}

function isInternalPage() {
  return window.location.href.startsWith('chrome://') ||
    window.location.href.startsWith('chrome-extension://') ||
    window.location.href.startsWith('about:') ||
    window.location.href.startsWith('moz-extension://');
}

function safeCss(value) {
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(value);
  return String(value || '').replace(/["\\]/g, '\\$&');
}

function getElementPath(el) {
  const parts = [];
  let current = el;
  for (let i = 0; i < 4 && current && current !== document.body; i++) {
    if (!current.tagName) break;
    let part = current.tagName.toLowerCase();
    if (current.id) {
      part += `#${current.id}`;
    } else if (current.className && typeof current.className === 'string') {
      const cls = current.className.trim().split(/\s+/).find(Boolean);
      if (cls) part += `.${cls}`;
    }
    parts.unshift(part);
    current = current.parentElement;
  }
  return parts.join(' > ');
}

function getFieldKey(el) {
  if (!el || !el.tagName) return '';
  const tag = el.tagName.toLowerCase();
  const name = el.name || el.id || el.getAttribute('aria-label') || el.getAttribute('data-testid') || '';
  const type = el.type || el.getAttribute('role') || 'text';
  return `${tag}:${type}:${name}:${getElementPath(el)}`;
}

function getByIdText(idList) {
  return String(idList || '')
    .split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent || '')
    .join(' ')
    .trim();
}

function findNearestText(el, selectors) {
  let current = el;
  for (let i = 0; i < 6 && current; i++) {
    for (const selector of selectors) {
      const found = current.querySelector?.(selector);
      const text = normalizeText(found?.innerText || found?.textContent || found?.getAttribute?.('aria-label'));
      if (text) return text;
    }
    current = current.parentElement;
  }
  return '';
}

function getElementLabel(el) {
  if (!el) return '';

  const aria = normalizeText(el.getAttribute?.('aria-label'));
  if (aria) return truncate(aria, 80);

  const labelledBy = getByIdText(el.getAttribute?.('aria-labelledby'));
  if (labelledBy) return truncate(labelledBy, 80);

  if (el.id) {
    const label = document.querySelector(`label[for="${safeCss(el.id)}"]`);
    const labelText = normalizeText(label?.innerText || label?.textContent);
    if (labelText) return truncate(labelText, 80);
  }

  const wrappingLabel = el.closest?.('label');
  const wrappingText = normalizeText(wrappingLabel?.innerText || wrappingLabel?.textContent);
  if (wrappingText) return truncate(wrappingText, 80);

  const direct = normalizeText(
    el.placeholder ||
    el.getAttribute?.('data-testid') ||
    el.getAttribute?.('data-test') ||
    el.getAttribute?.('data-cy') ||
    el.name ||
    el.title ||
    el.alt ||
    el.value ||
    el.innerText ||
    el.textContent ||
    el.id
  );
  if (direct) return truncate(direct, 80);

  const nearby = findNearestText(el, [
    'legend',
    'label',
    '[aria-label]',
    '[data-testid]',
    'h1,h2,h3,h4,h5,h6',
  ]);
  if (nearby) return truncate(nearby, 80);

  return el.tagName ? el.tagName.toLowerCase() : 'element';
}

function getFieldLabel(el) {
  if (!el) return '';

  const aria = normalizeText(el.getAttribute?.('aria-label'));
  if (aria) return truncate(aria, 80);

  const labelledBy = getByIdText(el.getAttribute?.('aria-labelledby'));
  if (labelledBy) return truncate(labelledBy, 80);

  if (el.id) {
    const label = document.querySelector(`label[for="${safeCss(el.id)}"]`);
    const labelText = normalizeText(label?.innerText || label?.textContent);
    if (labelText) return truncate(labelText, 80);
  }

  const wrappingLabel = el.closest?.('label');
  const wrappingText = normalizeText(wrappingLabel?.innerText || wrappingLabel?.textContent);
  if (wrappingText) return truncate(wrappingText, 80);

  const direct = normalizeText(
    el.placeholder ||
    el.getAttribute?.('data-testid') ||
    el.getAttribute?.('data-test') ||
    el.getAttribute?.('data-cy') ||
    el.name ||
    el.title ||
    el.alt ||
    el.id
  );
  if (direct) return truncate(direct, 80);

  const nearby = findNearestText(el, [
    'legend',
    'label',
    '[aria-label]',
    '[data-testid]',
    'h1,h2,h3,h4,h5,h6',
  ]);
  if (nearby) return truncate(nearby, 80);

  return el.tagName ? el.tagName.toLowerCase() : 'field';
}

function getSectionLabel(el) {
  let current = el;
  for (let i = 0; i < 7 && current && current !== document.body; i++) {
    const ownLabel = normalizeText(current.getAttribute?.('aria-label') || current.getAttribute?.('data-testid'));
    if (ownLabel && current !== el) return truncate(ownLabel, 80);

    const heading = current.querySelector?.('legend,h1,h2,h3,h4,h5,h6,[role="heading"]');
    const headingText = normalizeText(heading?.innerText || heading?.textContent || heading?.getAttribute?.('aria-label'));
    if (headingText) return truncate(headingText, 80);

    current = current.parentElement;
  }
  return '';
}

function getElementRole(el) {
  if (!el || !el.tagName) return 'element';
  const role = el.getAttribute?.('role');
  if (role) return role;
  const tag = el.tagName.toLowerCase();
  const type = String(el.type || '').toLowerCase();
  if (tag === 'select') return 'dropdown';
  if (tag === 'textarea') return 'text';
  if (tag === 'button') return 'button';
  if (tag === 'a') return 'link';
  if (tag === 'video' || tag === 'audio') return 'media';
  if (tag === 'input') {
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'range') return 'slider';
    if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
    return 'text';
  }
  if (el.isContentEditable || el.getAttribute?.('contenteditable') === 'true') return 'editor';
  return tag;
}

function classifyApp() {
  const host = window.location.hostname.toLowerCase();
  const href = window.location.href.toLowerCase();
  const title = document.title.toLowerCase();
  if (host.includes('youtube.com') || host.includes('youtu.be')) return 'youtube';
  if (host.includes('figma.com')) return 'figma';
  if (host.includes('excalidraw.com') || title.includes('excalidraw')) return 'excalidraw';
  if (host.includes('docs.google.com') && href.includes('/document/')) return 'google_docs';
  if (host.includes('docs.google.com') && href.includes('/spreadsheets/')) return 'google_sheets';
  if (host.includes('monkeytype.com') || title.includes('monkeytype')) return 'typing_practice';
  if (host.includes('jupyter') || href.includes('/lab') || href.includes('/notebooks/') || document.querySelector('.jp-Notebook,.jp-Cell')) return 'jupyter';
  if (document.querySelector('.monaco-editor,.monaco-workbench') || title.includes('vscode') || title.includes('openvscode')) return 'openvscode';
  if (document.querySelector('.cm-editor,.CodeMirror,.ace_editor')) return 'code_editor';
  if (host.includes('coderbyte') || host.includes('hackerrank') || host.includes('leetcode') || host.includes('coderpad') || host.includes('codepen') || host.includes('codesandbox')) return 'assessment';
  return 'generic';
}

function getPageContext() {
  return {
    pageUrl: window.location.href,
    pageTitle: document.title || '',
    app: classifyApp(),
    frame: window.top === window ? 'top' : 'frame',
  };
}

function isPasswordField(el) {
  return String(el?.type || '').toLowerCase() === 'password';
}

function isTextEditable(el) {
  if (!el || !el.tagName || isPasswordField(el)) return false;
  const tag = el.tagName.toLowerCase();
  const type = String(el.type || '').toLowerCase();
  if (document.designMode === 'on' && (tag === 'body' || tag === 'html')) return true;
  if (tag === 'textarea') return true;
  if (el.isContentEditable || el.getAttribute?.('contenteditable') === 'true') return true;
  if (tag !== 'input') return false;
  return !['checkbox', 'radio', 'range', 'color', 'file', 'hidden', 'submit', 'button', 'reset', 'image', 'password'].includes(type);
}

function getTextEditableElement(target) {
  if (!target) return null;
  const el = target.nodeType === Node.ELEMENT_NODE ? target : target.parentElement;
  if (!el) return null;
  if (isTextEditable(el)) return el;
  const editable = el.closest?.('input,textarea,[contenteditable="true"],[contenteditable=""],[contenteditable="plaintext-only"]');
  if (editable && isTextEditable(editable)) return editable;
  if (document.designMode === 'on') return document.body;
  return null;
}

function richEditorSelector() {
  return [
    '[role="textbox"]',
    '[aria-multiline="true"]',
    '.kix-appview-editor',
    '.kix-page-content-wrapper',
    '.docs-texteventtarget-iframe',
    '.ProseMirror',
    '.ql-editor',
    '.tox-edit-area',
    '.mce-content-body',
    '.notranslate[contenteditable="true"]',
    '#words',
    '.words',
    '.word.active',
  ].join(',');
}

function getRichEditorElement(target) {
  if (!target) return null;
  const el = target.nodeType === Node.ELEMENT_NODE ? target : target.parentElement;
  if (!el) return null;
  const app = classifyApp();
  const rich = el.closest?.(richEditorSelector());
  if (rich) return rich;
  if (app === 'google_docs') {
    return document.querySelector('.kix-appview-editor,.kix-page-content-wrapper,[role="textbox"]') || document.body;
  }
  if (app === 'typing_practice') {
    return document.querySelector('#words,.words,.word.active') || document.body;
  }
  if (document.designMode === 'on') return document.body;
  return null;
}

function isRichEditorTarget(el) {
  if (!el) return false;
  const app = classifyApp();
  if (app === 'google_docs' || app === 'typing_practice') return true;
  return Boolean(el.closest?.(richEditorSelector()));
}

function getTextCaptureElement(target) {
  return getTextEditableElement(target) || getRichEditorElement(target);
}

function isTextCaptureElement(el) {
  return Boolean(el && (isTextEditable(el) || isRichEditorTarget(el) || isCodeEditorTarget(el)));
}

function isCodeEditorTarget(el) {
  const app = classifyApp();
  if (['openvscode', 'jupyter', 'code_editor', 'assessment'].includes(app)) return true;
  return Boolean(el?.closest?.('.monaco-editor,.cm-editor,.CodeMirror,.ace_editor,.jp-InputArea,.jp-CodeCell,.view-lines'));
}

function getEditorName(el) {
  const app = classifyApp();
  if (app === 'assessment') return 'assessment editor';
  if (app === 'google_docs') return 'Google Docs';
  if (app === 'typing_practice') return 'typing practice';
  if (app === 'openvscode') {
    const tab = document.querySelector('.tabs-container .tab.active .label-name,.tabs-container .tab.active[aria-label],.monaco-workbench .tab.active .monaco-icon-label');
    const text = normalizeText(tab?.innerText || tab?.textContent || tab?.getAttribute?.('aria-label'));
    if (text) return truncate(text, 80);
  }
  if (app === 'jupyter') {
    const cell = el.closest?.('.jp-Cell');
    const cells = Array.from(document.querySelectorAll('.jp-Cell'));
    const index = cell ? cells.indexOf(cell) + 1 : 0;
    return index > 0 ? `Jupyter cell ${index}` : 'Jupyter cell';
  }
  return getElementLabel(el);
}

function visibleTextFromNodes(nodes, maxNodes = 250) {
  const lines = [];
  const seen = new Set();
  for (const node of Array.from(nodes || []).slice(0, maxNodes)) {
    const text = String(node.innerText || node.textContent || node.getAttribute?.('aria-label') || '').replace(/\u00a0/g, ' ');
    const normalized = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    lines.push(normalized);
  }
  return lines.join('\n');
}

function getRichEditorText(el) {
  const app = classifyApp();
  if (app === 'typing_practice') {
    const typed = document.querySelector('#wordsInput,input[autocomplete="off"],textarea')?.value || '';
    if (typed) return typed;
    const letters = Array.from(document.querySelectorAll('#words .letter.correct,#words .letter.incorrect,#words .letter.extra,.words .letter.correct,.words .letter.incorrect,.words .letter.extra'))
      .map((node) => node.textContent || '')
      .join('');
    if (letters) return letters;
  }

  const roots = [];
  if (el?.querySelectorAll) roots.push(el);
  roots.push(document);

  const selectors = [
    '.kix-lineview-text-block',
    '.kix-wordhtmlgenerator-word-node',
    '.kix-lineview-content',
    '.kix-paragraphrenderer',
    '.ProseMirror p,.ProseMirror li,.ProseMirror [data-node-view-content]',
    '.ql-editor p,.ql-editor li',
    '.mce-content-body p,.mce-content-body li',
    '[role="textbox"] p,[role="textbox"] div,[aria-multiline="true"] p,[aria-multiline="true"] div',
  ];

  for (const root of roots) {
    for (const selector of selectors) {
      const text = visibleTextFromNodes(root.querySelectorAll?.(selector));
      if (normalizeText(text)) return text;
    }
  }

  if (el && (el.innerText || el.textContent)) return String(el.innerText || el.textContent || '');
  return '';
}

function getEditorText(el) {
  const app = classifyApp();
  if (app === 'assessment' || app === 'openvscode' || app === 'code_editor') {
    const monacoRoots = Array.from(document.querySelectorAll('.monaco-editor.focused,.monaco-editor'));
    for (const root of monacoRoots) {
      const monacoText = visibleTextFromNodes(root.querySelectorAll?.('.view-lines .view-line'), 300);
      if (normalizeText(monacoText)) return monacoText;
    }

    const codeMirrorText = visibleTextFromNodes(document.querySelectorAll('.cm-editor.cm-focused .cm-line,.cm-content .cm-line,.CodeMirror-code pre,.ace_line'), 300);
    if (normalizeText(codeMirrorText)) return codeMirrorText;
  }
  return '';
}

function getElementValue(el) {
  if (!el || isPasswordField(el)) return '';
  const editorText = isCodeEditorTarget(el) ? getEditorText(el) : '';
  if (editorText) return editorText;
  const richText = isRichEditorTarget(el) ? getRichEditorText(el) : '';
  if (richText) return richText;
  const tag = el.tagName?.toLowerCase();
  const type = String(el.type || '').toLowerCase();
  if (tag === 'select') {
    const selected = Array.from(el.selectedOptions || []).map((option) => normalizeText(option.textContent || option.value)).filter(Boolean);
    return selected.length ? selected.join(', ') : normalizeText(el.value);
  }
  if (tag === 'input' && ['checkbox', 'radio'].includes(type)) {
    return el.checked ? 'checked' : 'unchecked';
  }
  if (tag === 'input' || tag === 'textarea') return String(el.value || '');
  if (el.isContentEditable || el.getAttribute?.('contenteditable') === 'true') return String(el.textContent || '');
  return normalizeText(el.innerText || el.textContent || el.value || '');
}

function getSemanticElement(el) {
  return {
    role: getElementRole(el),
    label: getFieldLabel(el),
    section: getSectionLabel(el),
    selectorPath: getElementPath(el),
  };
}

function describeClick(element) {
  const app = classifyApp();
  const label = element?.label || 'element';
  const section = element?.section ? ` in ${element.section}` : '';
  const role = element?.role || 'element';

  if (app === 'google_sheets' && (role === 'td' || role === 'gridcell' || role === 'cell')) {
    return `User selected spreadsheet cell "${label}"${section}`;
  }
  if (app === 'excalidraw' && (role === 'radio' || role === 'checkbox' || role === 'button' || role === 'label')) {
    return `User selected Excalidraw tool "${label}"${section}`;
  }
  if (role === 'tab') return `User switched to tab "${label}"${section}`;
  if (role === 'option' || role === 'menuitem') return `User selected option "${label}"${section}`;
  if (role === 'button') return `User clicked button "${label}"${section}`;
  if (role === 'link') return `User clicked link "${label}"${section}`;
  if (role && role !== 'element') return `User clicked ${role} "${label}"${section}`;
  return `User clicked "${label}"${section}`;
}

function describeChoiceChange(element, before, after) {
  const app = classifyApp();
  const label = element?.label || 'field';
  if (app === 'excalidraw' && after === 'checked') {
    return `User selected Excalidraw tool "${label}"`;
  }
  if (before && before !== after) {
    return `User changed "${label}" from "${truncate(before, 80)}" to "${truncate(after, 80)}"`;
  }
  return `User changed "${label}" to "${truncate(after, 80)}"`;
}

function buildMessage(action, element, extras = {}) {
  const label = element?.label || extras.label || 'element';
  const section = element?.section ? ` in ${element.section}` : '';
  return `${action} "${label}"${section}`;
}

function rememberAction(label) {
  lastActionAt = Date.now();
  lastActionLabel = label || '';
}

function sendActivity(type, payload) {
  sendToBackground(type, {
    ...getPageContext(),
    category: payload.category || 'interaction',
    message: payload.message || payload.human_log || type,
    details: {
      ...(payload.details || {}),
      confidence: payload.confidence ?? 0.85,
      human_log: payload.human_log || payload.message || '',
      app: classifyApp(),
    },
  });
}

function flushInput(el, reason = 'idle') {
  const entry = activeInputs.get(el);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);

  let finalText = getElementValue(entry.element);
  if (!normalizeText(finalText) && entry.typedText) finalText = entry.typedText;
  const trimmed = normalizeText(finalText);
  activeInputs.delete(el);
  valueSnapshots.set(entry.element, finalText);
  if (!trimmed) return;

  const currentHash = textHash(finalText);
  if (emittedInputHashes.get(entry.element) === currentHash) return;
  emittedInputHashes.set(entry.element, currentHash);

  const lines = countLines(finalText);
  const textPreview = truncate(finalText);
  const isCode = entry.isCode;
  const isRich = entry.isRich;
  const editorName = isCode ? getEditorName(entry.element) : '';
  const message = isCode
    ? `User edited ${editorName || 'code editor'}${lines > 1 ? ` (${lines} lines)` : ''}: "${textPreview}"`
    : isRich
      ? `User edited ${entry.fieldName || 'rich text editor'}${lines > 1 ? ` (${lines} lines)` : ''}: "${textPreview}"`
    : `User typed in "${entry.fieldName}": "${textPreview}"`;

  sendToBackground(isCode ? 'code_edit' : 'text_input', {
    ...getPageContext(),
    category: isCode ? 'editor' : 'input',
    message,
    text: rawLimit(finalText),
    fieldType: entry.fieldType,
    fieldName: entry.fieldName,
    textLength: String(finalText || '').length,
    lineCount: lines,
    reason,
    details: {
      element: entry.elementMeta,
      editorName,
      typedTextPreview: entry.typedText ? truncate(entry.typedText) : '',
      textPreview,
      textLength: String(finalText || '').length,
      lineCount: lines,
      reason,
      confidence: isCode ? 0.82 : 0.92,
      human_log: message,
      app: classifyApp(),
    },
  });
}

function flushAllInputs(reason = 'flush') {
  Array.from(activeInputs.keys()).forEach((el) => flushInput(el, reason));
}

function handleTextInput(el) {
  el = getTextCaptureElement(el);
  if (!isTextCaptureElement(el)) return;

  const text = getElementValue(el);
  const elementMeta = getSemanticElement(el);
  const isCode = isCodeEditorTarget(el);
  const isRich = !isCode && isRichEditorTarget(el);
  const existing = activeInputs.get(el);
  if (existing?.timer) clearTimeout(existing.timer);
  const startedAt = existing?.startedAt || Date.now();

  const timer = setTimeout(() => {
    flushInput(el, 'idle');
  }, isCode ? CODE_INPUT_DEBOUNCE_MS : INPUT_DEBOUNCE_MS);

  activeInputs.set(el, {
    timer,
    text,
    element: el,
    fieldType: el.type || (el.tagName === 'TEXTAREA' ? 'textarea' : 'contenteditable'),
    fieldName: isCode || isRich ? getEditorName(el) : getFieldLabel(el),
    elementMeta,
    isCode,
    isRich,
    typedText: existing?.typedText || '',
    startedAt,
  });

  if (!isCode && Date.now() - startedAt >= INPUT_MAX_AGE_MS) {
    flushInput(el, 'typing_max_age');
  }
}

function handleBeforeInput(e) {
  const el = getTextCaptureElement(e.target);
  if (!isTextCaptureElement(el)) return;
  recentBeforeInputAt.set(el, Date.now());
  if (!valueSnapshots.has(el)) valueSnapshots.set(el, getElementValue(el));

  const inputType = String(e.inputType || '');
  const fragment = typeof e.data === 'string'
    ? e.data
    : inputType === 'insertParagraph' || inputType === 'insertLineBreak'
      ? '\n'
      : '';
  if (!fragment) return;

  const existing = activeInputs.get(el) || {};
  const isCode = isCodeEditorTarget(el);
  const isRich = !isCode && isRichEditorTarget(el);
  if (existing.timer) clearTimeout(existing.timer);
  const timer = setTimeout(() => flushInput(el, 'idle'), isCode ? CODE_INPUT_DEBOUNCE_MS : INPUT_DEBOUNCE_MS);
  activeInputs.set(el, {
    ...existing,
    timer,
    text: existing.text || '',
    element: el,
    fieldType: el.type || (el.tagName === 'TEXTAREA' ? 'textarea' : 'contenteditable'),
    fieldName: existing.fieldName || (isCode || isRich ? getEditorName(el) : getFieldLabel(el)),
    elementMeta: existing.elementMeta || getSemanticElement(el),
    isCode,
    isRich,
    typedText: rawLimit(`${existing.typedText || ''}${fragment}`),
    startedAt: existing.startedAt || Date.now(),
  });
}

function handleKeydown(e) {
  const el = getTextCaptureElement(e.target);
  if (!isTextCaptureElement(el)) return;
  if (isCodeEditorTarget(el) || isRichEditorTarget(el)) {
    if (isRichEditorTarget(el) && e.key && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const key = e.key;
      setTimeout(() => {
        if (Date.now() - (recentBeforeInputAt.get(el) || 0) <= 120) return;
        const existing = activeInputs.get(el) || {};
        if (existing.timer) clearTimeout(existing.timer);
        const timer = setTimeout(() => flushInput(el, 'idle'), INPUT_DEBOUNCE_MS);
        activeInputs.set(el, {
          ...existing,
          timer,
          text: existing.text || '',
          element: el,
          fieldType: el.type || (el.tagName === 'TEXTAREA' ? 'textarea' : 'contenteditable'),
          fieldName: existing.fieldName || getEditorName(el),
          elementMeta: existing.elementMeta || getSemanticElement(el),
          isCode: false,
          isRich: true,
          typedText: rawLimit(`${existing.typedText || ''}${key}`),
          startedAt: existing.startedAt || Date.now(),
        });
        handleTextInput(el);
      }, 80);
    }
    if ((e.key && e.key.length === 1) || e.key === 'Enter' || e.key === 'Backspace' || e.key === 'Delete') {
      setTimeout(() => handleTextInput(el), 60);
    }
    return;
  }
  if (e.key === 'Enter' || e.key === 'Tab' || e.key === 'Escape') {
    setTimeout(() => flushInput(el, `key_${String(e.key || '').toLowerCase()}`), 0);
  }
}

function handleChange(e) {
  const el = e.target;
  if (!el || !el.tagName || isPasswordField(el)) return;

  const tag = el.tagName.toLowerCase();
  const type = String(el.type || '').toLowerCase();
  const isChoice = tag === 'select' || ['checkbox', 'radio', 'range', 'color'].includes(type);
  if (!isChoice && !isTextEditable(el)) return;

  const before = valueSnapshots.has(el) ? valueSnapshots.get(el) : '';
  const after = getElementValue(el);
  valueSnapshots.set(el, after);

  if (!isChoice) {
    handleTextInput(el);
    return;
  }

  const element = getSemanticElement(el);
  const role = element.role;
  const eventType = role === 'dropdown' ? 'select_change' : role === 'checkbox' ? 'checkbox_change' : role === 'radio' ? 'radio_change' : 'field_change';
  const message = describeChoiceChange(element, before, after);

  rememberAction(element.label);
  sendActivity(eventType, {
    category: 'input',
    message,
    human_log: message,
    confidence: 0.95,
    details: {
      element,
      before: truncate(before, 120),
      after: truncate(after, 120),
      value: truncate(after, 120),
    },
  });
}

function snapshotControlValue(e) {
  const el = e.target;
  if (!el || !el.tagName || isPasswordField(el)) return;
  const tag = el.tagName.toLowerCase();
  const type = String(el.type || '').toLowerCase();
  const capture = getTextCaptureElement(el);
  if (tag === 'select' || ['checkbox', 'radio', 'range', 'color'].includes(type) || isTextCaptureElement(capture || el)) {
    valueSnapshots.set(capture || el, getElementValue(capture || el));
  }
}

function getClickableElement(target) {
  return target?.closest?.('button,a,input[type="button"],input[type="submit"],input[type="reset"],input[type="image"],[role="button"],[role="menuitem"],[role="option"],[role="tab"],[role="switch"],summary,label,[aria-label],[data-testid],video,audio');
}

function noteUserGesture(e) {
  recentUserGestureAt = Date.now();
  if (e?.target?.closest?.('video,audio,[aria-label*="play" i],[aria-label*="pause" i],[class*="player" i],[class*="media" i]')) {
    recentMediaGestureAt = recentUserGestureAt;
  }
}

function handleClick(e) {
  noteUserGesture(e);
  const el = getClickableElement(e.target);
  if (!el || isTextEditable(el)) return;
  if (el.tagName === 'INPUT' && ['checkbox', 'radio', 'range', 'color'].includes(String(el.type || '').toLowerCase())) return;
  if (el.tagName === 'SELECT') return;

  const element = getSemanticElement(el);
  const label = element.label;
  if (!label || ['html', 'body', 'div', 'span', 'element'].includes(label.toLowerCase())) return;

  const key = `${label}:${element.role}:${element.selectorPath}`;
  const now = Date.now();
  if (now - (recentClicks.get(key) || 0) < CLICK_THROTTLE_MS) return;
  recentClicks.set(key, now);
  flushAllInputs('click');

  const message = describeClick(element);

  rememberAction(label);
  scheduleOutputScans(label);
  sendActivity('element_click', {
    category: 'interaction',
    message,
    human_log: message,
    confidence: element.role === 'button' || element.role === 'link' ? 0.92 : 0.78,
    details: {
      element,
      pointer: {
        x: Math.round(e.clientX || 0),
        y: Math.round(e.clientY || 0),
      },
    },
  });
}

function mediaTime(el) {
  const seconds = Number(el.currentTime || 0);
  if (!Number.isFinite(seconds)) return '';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function isVisibleMedia(el) {
  const rect = el.getBoundingClientRect?.();
  if (!rect) return true;
  if (rect.width < 80 || rect.height < 45) return false;
  if (rect.bottom < 0 || rect.right < 0) return false;
  if (rect.top > window.innerHeight || rect.left > window.innerWidth) return false;
  const style = window.getComputedStyle?.(el);
  return !(style?.display === 'none' || style?.visibility === 'hidden' || Number(style?.opacity) === 0);
}

function shouldLogMedia(type, el, element, label) {
  const now = Date.now();
  const app = classifyApp();
  const currentTime = Number(el.currentTime || 0);
  const directMediaIntent = now - recentMediaGestureAt <= MEDIA_USER_WINDOW_MS;
  const recentIntent = directMediaIntent || now - recentUserGestureAt <= MEDIA_USER_WINDOW_MS;
  const startupNoise = now - pageStartedAt < 8000 && currentTime < 1.5;

  if (!isVisibleMedia(el)) return false;
  if (window.location.hostname.toLowerCase().includes('translucid.cloud') && !directMediaIntent) return false;
  if (app !== 'youtube' && !recentIntent && (startupNoise || type !== 'media_seek')) return false;

  const previous = mediaStates.get(el) || {};
  if (type === 'media_rate_change' && previous.playbackRate === el.playbackRate) return false;
  if (type === 'media_volume_change' && previous.volume === el.volume && previous.muted === el.muted) return false;
  if ((type === 'media_rate_change' || type === 'media_volume_change') && !directMediaIntent) return false;

  const bucket = Math.floor(currentTime / 3);
  const signature = `${type}:${label}:${element.selectorPath}:${bucket}:${el.playbackRate || 1}:${Boolean(el.muted)}:${Math.round((el.volume || 0) * 10)}`;
  pruneRecentMap(recentMediaEvents, MEDIA_DEDUPE_MS * 2);
  if (now - (recentMediaEvents.get(signature) || 0) < MEDIA_DEDUPE_MS) return false;
  recentMediaEvents.set(signature, now);

  mediaStates.set(el, {
    currentTime,
    playbackRate: el.playbackRate,
    muted: Boolean(el.muted),
    volume: el.volume,
    paused: Boolean(el.paused),
  });
  return true;
}

function handleMedia(type, el) {
  if (!el || !['VIDEO', 'AUDIO'].includes(el.tagName)) return;
  const element = getSemanticElement(el);
  const label = document.title || element.label || 'media';
  if (!shouldLogMedia(type, el, element, label)) return;
  const time = mediaTime(el);
  const verb = type.replace('media_', '').replace('_', ' ');
  const message = type === 'media_seek'
    ? `User seeked media in "${label}" to ${time}`
    : `User ${verb} media in "${label}"${time ? ` at ${time}` : ''}`;

  rememberAction(label);
  sendActivity(type, {
    category: 'media',
    message,
    human_log: message,
    confidence: 0.95,
    details: {
      element,
      currentTime: el.currentTime || 0,
      duration: el.duration || 0,
      paused: Boolean(el.paused),
      playbackRate: el.playbackRate || 1,
      muted: Boolean(el.muted),
      volume: el.volume,
    },
  });
}

function handleSelectionChange() {
  const now = Date.now();
  if (now - lastSelectionAt < SELECTION_THROTTLE_MS) return;
  const selection = window.getSelection();
  const text = selection ? selection.toString() : '';
  if (normalizeText(text).length < 20) return;
  lastSelectionAt = now;

  sendActivity('selection_change', {
    category: 'selection',
    message: `User selected text: "${truncate(text, 120)}"`,
    human_log: `User selected text: "${truncate(text, 120)}"`,
    confidence: 0.78,
    details: {
      textPreview: truncate(text, 180),
      textLength: text.length,
    },
  });
}

function handleClipboard(type, e) {
  const active = document.activeElement;
  const element = active ? getSemanticElement(active) : {};
  let text = '';

  if (type === 'clipboard_copy' || type === 'clipboard_cut') {
    const selection = window.getSelection();
    text = selection ? selection.toString() : '';
  } else if (e.clipboardData) {
    text = e.clipboardData.getData('text/plain') || '';
  }

  const lineCount = countLines(text);
  const dedupeKey = `${type}:${textHash(text)}:${element.label || ''}:${window.location.href}`;
  pruneRecentMap(recentClipboard, 5000);
  if (Date.now() - (recentClipboard.get(dedupeKey) || 0) < 2500) return;
  recentClipboard.set(dedupeKey, Date.now());

  const action = type === 'clipboard_paste' ? 'pasted' : type === 'clipboard_cut' ? 'cut' : 'copied';
  const target = element.label ? ` in "${element.label}"` : '';
  const message = `User ${action} text${target} (${text.length} chars${lineCount > 1 ? `, ${lineCount} lines` : ''})`;

  const editableActive = getTextEditableElement(active);
  if (type === 'clipboard_paste' && editableActive) {
    setTimeout(() => handleTextInput(editableActive), 0);
  }

  sendToBackground(type, {
    ...getPageContext(),
    category: 'input',
    message,
    text: rawLimit(text, 500),
    textLength: text.length,
    details: {
      element,
      textPreview: truncate(text),
      textLength: text.length,
      lineCount,
      confidence: type === 'clipboard_paste' ? 0.95 : 0.88,
      human_log: message,
      app: classifyApp(),
    },
  });
}

function handleSubmit(e) {
  const form = e.target;
  if (!form || form.tagName?.toLowerCase() !== 'form') return;
  flushAllInputs('submit');

  const label = getElementLabel(form) || getSectionLabel(form) || window.location.hostname;
  const action = form.action || window.location.href;
  const method = (form.method || 'GET').toUpperCase();
  const message = `User submitted form "${truncate(label, 80)}"`;

  rememberAction(label);
  scheduleOutputScans(label);
  sendActivity('form_submit', {
    category: 'input',
    message,
    human_log: message,
    confidence: 0.95,
    details: {
      action,
      method,
      formId: form.id || '',
      formName: form.name || '',
      fieldCount: form.elements?.length || 0,
    },
  });
}

function outputSelector() {
  return [
    '[role="alert"]',
    '[role="status"]',
    '.error',
    '.alert',
    '.toast',
    '.notification',
    '.jp-OutputArea',
    '.jp-RenderedText',
    '.output',
    '.test-results',
    '.xterm-rows',
    '.xterm-screen',
    '.terminal-wrapper',
    '[aria-label*="terminal" i]',
    '[class*="output" i]',
    '[class*="console" i]',
    '[class*="terminal" i]',
    '[class*="result" i]',
    '[class*="stderr" i]',
    '[class*="stdout" i]',
    'pre',
  ].join(',');
}

function isLikelyRunAction(label) {
  const text = normalizeText(label).toLowerCase();
  return /\b(run|test|submit|execute|check|compile|evaluate|verify)\b/.test(text);
}

function cleanOutputText(text) {
  const normalized = String(text || '').replace(/\r/g, '').split('\n').map((line) => line.trimEnd()).filter(Boolean);
  const joined = normalizeText(normalized.join('\n'));
  if (!joined || joined.length < 8) return '';
  if (/output logs will appear here|no output yet|run code to see output|nothing to show/i.test(joined)) return '';

  const important = [];
  const rest = [];
  for (const line of normalized) {
    const compact = normalizeText(line);
    if (!compact) continue;
    if (/error|exception|failed|failure|exit code|expected|actual|stdout|stderr|syntaxerror|typeerror|referenceerror|passed|success|output/i.test(compact)) {
      important.push(compact);
    } else if (rest.length < 8) {
      rest.push(compact);
    }
  }
  const selected = important.length ? important.slice(0, 8) : rest.slice(0, 8);
  return truncate(selected.join(' | ') || joined, 320);
}

function terminalSelector() {
  return [
    '.xterm-rows',
    '.xterm-screen',
    '.terminal-wrapper',
    '[aria-label*="terminal" i]',
    '[class*="terminal" i]',
  ].join(',');
}

function getTerminalRoot(target) {
  if (!target) return null;
  const el = target.nodeType === Node.ELEMENT_NODE ? target : target.parentElement;
  if (!el) return null;
  if (el.matches?.(terminalSelector())) return el;
  return el.closest?.(terminalSelector()) || null;
}

function getTerminalText(root) {
  if (!root) return '';
  const lineText = visibleTextFromNodes(root.querySelectorAll?.('.xterm-rows > div,.xterm-rows .xterm-row,.terminal-output-line,.terminal-line'), 160);
  if (normalizeText(lineText)) return lineText;
  return String(root.innerText || root.textContent || '');
}

function cleanTerminalText(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n').map((line) => line.trimEnd()).filter(Boolean);
  const selected = lines.slice(-14).map((line) => normalizeText(line)).filter(Boolean);
  return truncate(selected.join(' | '), 360);
}

function emitTerminalOutput(text) {
  const summary = cleanTerminalText(text);
  if (!summary || summary.length < 8) return false;
  const now = Date.now();
  if (now - lastTerminalOutputAt < TERMINAL_OUTPUT_THROTTLE_MS) return false;
  const hash = textHash(summary);
  pruneRecentMap(recentTerminalOutputs, OUTPUT_DEDUPE_MS * 2);
  if (now - (recentTerminalOutputs.get(hash) || 0) < OUTPUT_DEDUPE_MS) return false;
  recentTerminalOutputs.set(hash, now);
  lastTerminalOutputAt = now;

  const message = `Terminal output: "${summary}"`;
  sendActivity('run_output', {
    category: 'terminal',
    message,
    human_log: message,
    confidence: 0.82,
    details: {
      textPreview: summary,
      textLength: String(text || '').length,
      relatedAction: lastActionLabel || 'terminal',
      outputKind: 'terminal_output',
    },
  });
  return true;
}

function findOutputCandidates(root = document) {
  const selector = outputSelector();
  const candidates = [];
  try {
    if (root.nodeType === 1 && root.matches?.(selector)) candidates.push(root);
    candidates.push(...Array.from(root.querySelectorAll?.(selector) || []));
  } catch (e) {
  }
  return candidates;
}

function emitOutputSummary(text, relatedAction = lastActionLabel) {
  const summary = cleanOutputText(text);
  if (!summary) return false;

  const now = Date.now();
  const hash = textHash(summary);
  pruneRecentMap(recentOutputs, OUTPUT_DEDUPE_MS * 2);
  if (now - (recentOutputs.get(hash) || 0) < OUTPUT_DEDUPE_MS) return false;
  recentOutputs.set(hash, now);
  lastOutputAt = now;

  const runLike = isLikelyRunAction(relatedAction) || classifyApp() === 'assessment';
  const message = runLike
    ? `Run output after "${relatedAction || 'recent action'}": "${summary}"`
    : relatedAction
      ? `Page showed output after "${relatedAction}": "${summary}"`
      : `Page showed output: "${summary}"`;

  sendActivity(runLike ? 'run_output' : 'ui_output_change', {
    category: 'interaction',
    message,
    human_log: message,
    confidence: runLike ? 0.84 : 0.72,
    details: {
      textPreview: summary,
      textLength: String(text || '').length,
      relatedAction,
      outputKind: runLike ? 'run_output' : 'ui_output',
    },
  });
  return true;
}

function scanForOutputs(relatedAction = lastActionLabel) {
  if (!document.body) return false;
  const candidates = findOutputCandidates(document.body);
  const scored = candidates
    .map((el) => {
      const text = el.innerText || el.textContent || '';
      const compact = normalizeText(text);
      const score = (/(error|exception|exit code|expected|actual|passed|failed|output|stdout|stderr)/i.test(compact) ? 1000 : 0) + Math.min(compact.length, 800);
      return { el, text, compact, score };
    })
    .filter((item) => item.compact.length >= 8)
    .sort((a, b) => b.score - a.score);
  for (const item of scored.slice(0, 8)) {
    if (emitOutputSummary(item.text, relatedAction)) return true;
  }
  return false;
}

function scheduleOutputScans(label) {
  if (!isLikelyRunAction(label) && classifyApp() !== 'assessment') return;
  [500, 1500, 3500, 7000].forEach((delay) => {
    setTimeout(() => scanForOutputs(label), delay);
  });
}

function observeOutputChanges() {
  if (!document.body || !window.MutationObserver) return;
  const observer = new MutationObserver((mutations) => {
    const now = Date.now();
    for (const mutation of mutations) {
      const terminalRoot = getTerminalRoot(mutation.target);
      if (terminalRoot && emitTerminalOutput(getTerminalText(terminalRoot))) return;
      for (const node of mutation.addedNodes || []) {
        const addedTerminalRoot = getTerminalRoot(node);
        if (addedTerminalRoot && emitTerminalOutput(getTerminalText(addedTerminalRoot))) return;
      }
    }
    if (now - lastActionAt > OUTPUT_CORRELATION_MS || now - lastOutputAt < OUTPUT_THROTTLE_MS) return;

    for (const mutation of mutations) {
      if (mutation.type === 'characterData') {
        const parent = mutation.target?.parentElement;
        const text = parent ? parent.innerText || parent.textContent : mutation.target?.textContent;
        if (emitOutputSummary(text, lastActionLabel)) return;
      }
      for (const node of mutation.addedNodes || []) {
        if (!node || node.nodeType !== 1) continue;
        for (const output of findOutputCandidates(node)) {
          const text = output.innerText || output.textContent;
          if (emitOutputSummary(text, lastActionLabel)) return;
        }
      }
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
}

function sendToBackground(type, data) {
  try {
    const runtime = typeof chrome !== 'undefined' ? chrome.runtime :
                    typeof browser !== 'undefined' ? browser.runtime : null;

    if (runtime && runtime.sendMessage) {
      runtime.sendMessage({ type, ...data }, () => {
        if (typeof chrome !== 'undefined' && chrome.runtime?.lastError) {
        }
      });
    }
  } catch (e) {
  }
}

if (!isInternalPage()) {
  document.addEventListener('focusin', snapshotControlValue, true);
  document.addEventListener('pointerdown', (e) => {
    noteUserGesture(e);
    snapshotControlValue(e);
  }, true);
  document.addEventListener('beforeinput', handleBeforeInput, true);
  document.addEventListener('keydown', handleKeydown, true);
  document.addEventListener('input', (e) => handleTextInput(e.target), true);
  document.addEventListener('change', handleChange, true);
  document.addEventListener('focusout', (e) => {
    const el = getTextCaptureElement(e.target);
    if (el) flushInput(el, 'focusout');
  }, true);
  document.addEventListener('click', handleClick, true);
  document.addEventListener('copy', (e) => handleClipboard('clipboard_copy', e), true);
  document.addEventListener('cut', (e) => handleClipboard('clipboard_cut', e), true);
  document.addEventListener('paste', (e) => handleClipboard('clipboard_paste', e), true);
  document.addEventListener('submit', handleSubmit, true);
  document.addEventListener('selectionchange', handleSelectionChange, true);
  document.addEventListener('play', (e) => handleMedia('media_play', e.target), true);
  document.addEventListener('pause', (e) => handleMedia('media_pause', e.target), true);
  document.addEventListener('seeked', (e) => handleMedia('media_seek', e.target), true);
  document.addEventListener('ratechange', (e) => handleMedia('media_rate_change', e.target), true);
  document.addEventListener('volumechange', (e) => handleMedia('media_volume_change', e.target), true);
  window.addEventListener('blur', () => flushAllInputs('blur'), true);
  window.addEventListener('beforeunload', () => flushAllInputs('navigation'), true);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushAllInputs('hidden');
  }, true);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', observeOutputChanges, { once: true });
  } else {
    observeOutputChanges();
  }
}
