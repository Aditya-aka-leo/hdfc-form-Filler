// ─── Helpers ─────────────────────────────────────────────────────────────────

function storageKey(pathname) {
  return `journey_${pathname}`;
}

function fmt(isoString) {
  const d = new Date(isoString);
  return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' }) +
    ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function uuid() {
  return crypto.randomUUID();
}

/** "customerName" → "Customer Name" */
function fieldLabel(name) {
  return name.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()).trim();
}

function truncateValue(val) {
  const s = String(val);
  return s.length > 28 ? s.slice(0, 28) + '…' : s;
}


let statusTimer = null;

function setStatus(msg, type = 'default') {
  const bar = document.getElementById('statusBar');
  bar.textContent = msg;
  bar.className = type === 'error' ? 'error' : type === 'success' ? 'success' : '';
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { bar.textContent = ''; bar.className = ''; }, 3000);
}

// ─── Active replay state ──────────────────────────────────────────────────────

let activeReplayId = null;

function setActiveReplay(session) {
  activeReplayId = session ? session.id : null;
  const bar = document.getElementById('activeReplayBar');
  const label = document.getElementById('activeReplayLabel');
  const dot = document.getElementById('statusDot');
  const statusLabel = document.getElementById('statusLabel');

  if (session) {
    bar.classList.add('visible');
    label.textContent = session.label;
    dot.classList.add('replay-mode');
    if (statusLabel) statusLabel.textContent = 'PLAYING';
  } else {
    bar.classList.remove('visible');
    dot.classList.remove('replay-mode');
    if (statusLabel) statusLabel.textContent = 'REC';
  }
}

// ─── Storage ──────────────────────────────────────────────────────────────────

async function getTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function loadSessions(pathname) {
  const key = storageKey(pathname);
  const result = await chrome.storage.local.get(key);
  return (result[key] && result[key].sessions) ? result[key].sessions : [];
}

async function saveSessions(pathname, sessions) {
  const key = storageKey(pathname);
  await chrome.storage.local.set({ [key]: { sessions } });
}

// ─── Copy Sheet ──────────────────────────────────────────────────────────────

// copyData holds { title, sections: [{label, fields: {key:val}}] }
let copyData = null;

/**
 * @param {string} title - sheet title
 * @param {Array<{label:string|null, fields:{[k:string]:string}}>} sections
 */
function openCopyPanel(title, sections) {
  copyData = { title, sections };
  document.getElementById('copySheetTitle').textContent = title;

  const list = document.getElementById('copyFieldList');
  list.innerHTML = '';

  sections.forEach(({ label, fields }) => {
    if (label) {
      const divider = document.createElement('div');
      divider.className = 'copy-section-label';
      divider.textContent = label;
      list.appendChild(divider);
    }

    Object.entries(fields).forEach(([key, val]) => {
      const row = document.createElement('label');
      row.className = 'copy-field-row';
      row.innerHTML = `
        <input type="checkbox" checked data-field="${key}" />
        <span class="copy-check">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        </span>
        <div class="copy-field-info">
          <span class="copy-field-name">${key}</span>
          <span class="copy-field-value">${truncateValue(val)}</span>
        </div>
      `;
      list.appendChild(row);
    });
  });

  updateCopyCount();
  document.getElementById('sheetOverlay').classList.add('open');
  document.getElementById('copySheet').classList.add('open');
}

function closeCopyPanel() {
  document.getElementById('sheetOverlay').classList.remove('open');
  document.getElementById('copySheet').classList.remove('open');
  copyData = null;
}

function updateCopyCount() {
  const total = document.querySelectorAll('#copyFieldList input[type="checkbox"]').length;
  const checked = document.querySelectorAll('#copyFieldList input[type="checkbox"]:checked').length;
  document.getElementById('copyCount').textContent = `${checked} of ${total}`;

  const btnAll = document.getElementById('btnSelectAll');
  if (btnAll) btnAll.textContent = checked === total ? 'Deselect all' : 'Select all';
}

async function copyFieldsToClipboard() {
  if (!copyData) return;

  // Build a merged lookup of all fields across all sections
  const allFields = {};
  copyData.sections.forEach(({ fields }) => Object.assign(allFields, fields));

  const checkboxes = document.querySelectorAll('#copyFieldList input[type="checkbox"]');
  const result = {};
  checkboxes.forEach(cb => {
    if (cb.checked) result[cb.dataset.field] = allFields[cb.dataset.field];
  });

  await navigator.clipboard.writeText(JSON.stringify(result, null, 2));

  const btn = document.getElementById('btnCopyJSON');
  const original = btn.innerHTML;
  btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Copied!`;
  btn.disabled = true;
  setTimeout(() => { btn.innerHTML = original; btn.disabled = false; }, 1800);
}

// ─── Field panel ─────────────────────────────────────────────────────────────

let openPanelId = null;

function enabledCount(session) {
  const excluded = new Set(session.excluded || []);
  return Object.keys(session.data).length - excluded.size;
}

function buildFieldPanel(session, pathname) {
  const excluded = new Set(session.excluded || []);
  const fields = Object.entries(session.data);

  const panel = document.createElement('div');
  panel.className = 'field-panel';
  panel.dataset.panelId = session.id;

  const header = document.createElement('div');
  header.className = 'field-panel-header';
  header.innerHTML = `
    <span class="field-panel-title">Fields</span>
    <span class="field-panel-count" id="panel-count-${session.id}">
      ${enabledCount(session)} of ${fields.length} will prefill
    </span>
  `;
  panel.appendChild(header);

  const list = document.createElement('div');
  list.className = 'field-panel-list';

  fields.forEach(([key, val]) => {
    const isEnabled = !excluded.has(key);
    const row = document.createElement('div');
    row.className = 'field-row' + (isEnabled ? '' : ' field-row-disabled');

    row.innerHTML = `
      <div class="field-row-info">
        <span class="field-row-name">${fieldLabel(key)}</span>
        <span class="field-row-value">${truncateValue(val)}</span>
      </div>
      <label class="toggle">
        <input type="checkbox" ${isEnabled ? 'checked' : ''} />
        <span class="toggle-track"><span class="toggle-thumb"></span></span>
      </label>
    `;

    row.querySelector('input').addEventListener('change', async (e) => {
      row.classList.toggle('field-row-disabled', !e.target.checked);
      await toggleExclusion(session.id, key, e.target.checked, pathname);
    });

    list.appendChild(row);
  });

  panel.appendChild(list);
  return panel;
}

async function toggleExclusion(sessionId, fieldName, isEnabled, pathname) {
  const sessions = await loadSessions(pathname);
  const session = sessions.find(s => s.id === sessionId);
  if (!session) return;

  if (!session.excluded) session.excluded = [];
  if (isEnabled) {
    session.excluded = session.excluded.filter(f => f !== fieldName);
  } else if (!session.excluded.includes(fieldName)) {
    session.excluded.push(fieldName);
  }

  await saveSessions(pathname, sessions);

  // Update count label in-place — no full re-render needed
  const countEl = document.getElementById(`panel-count-${sessionId}`);
  if (countEl) {
    const total = Object.keys(session.data).length;
    countEl.textContent = `${total - session.excluded.length} of ${total} will prefill`;
  }
}

// ─── Render journey list ──────────────────────────────────────────────────────

function renderList(sessions, pathname) {
  const list = document.getElementById('journeyList');

  if (!sessions.length) {
    openPanelId = null;
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🗂</div>
        <div>No journeys saved yet.<br/>Fill a form and hit Save.</div>
      </div>`;
    return;
  }

  list.innerHTML = '';
  sessions.forEach((session) => {
    const isActive = activeReplayId === session.id;
    const isPanelOpen = openPanelId === session.id;

    const item = document.createElement('div');
    item.className = 'journey-item';

    item.innerHTML = `
      <div class="journey-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
        </svg>
      </div>
      <div class="journey-info">
        <div class="journey-label" title="${session.label}">${session.label}</div>
        <div class="journey-meta">
          <span class="journey-date">${fmt(session.savedAt)}</span>
          <span class="field-pill">${Object.keys(session.data).length} fields</span>
        </div>
        <div class="journey-sub-actions"></div>
      </div>
    `;

    const actions = item.querySelector('.journey-sub-actions');

    // Settings / configure button
    const btnConfigure = document.createElement('button');
    btnConfigure.className = 'btn btn-ghost btn-sm btn-icon' + (isPanelOpen ? ' btn-active' : '');
    btnConfigure.title = 'Configure fields';
    btnConfigure.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/>
      <line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/>
      <line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/>
      <line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/>
      <line x1="17" y1="16" x2="23" y2="16"/>
    </svg>`;
    btnConfigure.addEventListener('click', () => {
      // Close any existing panel
      document.querySelectorAll('.field-panel').forEach(p => p.remove());
      document.querySelectorAll('.btn-active').forEach(b => b.classList.remove('btn-active'));

      if (openPanelId === session.id) {
        // Toggle off
        openPanelId = null;
      } else {
        openPanelId = session.id;
        btnConfigure.classList.add('btn-active');
        const panel = buildFieldPanel(session, pathname);
        item.insertAdjacentElement('afterend', panel);
      }
    });

    // Replay button
    const btnReplay = document.createElement('button');
    btnReplay.className = 'btn-play';
    btnReplay.title = isActive ? 'Active' : 'Replay';
    btnReplay.innerHTML = isActive
      ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>`
      : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3" fill="currentColor" stroke="none"/></svg>`;
    btnReplay.disabled = isActive;
    btnReplay.addEventListener('click', () => startReplay(session, pathname));

    // Delete button
    const btnDelete = document.createElement('button');
    btnDelete.className = 'btn btn-danger-ghost btn-sm btn-icon';
    btnDelete.title = 'Delete';
    btnDelete.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>`;
    btnDelete.addEventListener('click', () => deleteSession(session.id, pathname));

    actions.appendChild(btnConfigure);
    actions.appendChild(btnDelete);
    item.appendChild(btnReplay);
    list.appendChild(item);

    // Re-attach open panel after re-render
    if (isPanelOpen) {
      const panel = buildFieldPanel(session, pathname);
      list.appendChild(panel);
    }
  });
}

// ─── Actions ──────────────────────────────────────────────────────────────────

async function saveJourney(pathname) {
  const nameInput = document.getElementById('journeyName');
  const label = nameInput.value.trim();
  if (!label) {
    setStatus('Please enter a journey name.', 'error');
    nameInput.focus();
    return;
  }

  const tab = await getTab();
  let current;
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_CURRENT' });
    current = response.data;
  } catch {
    setStatus('Could not connect to page. Reload the form tab.', 'error');
    return;
  }

  if (!Object.keys(current).length) {
    setStatus('No fields recorded yet. Fill in the form first.', 'error');
    return;
  }

  const sessions = await loadSessions(pathname);
  sessions.unshift({
    id: uuid(),
    label,
    savedAt: new Date().toISOString(),
    data: current,
    excluded: [],
  });

  await saveSessions(pathname, sessions);
  nameInput.value = '';
  setStatus(`Saved "${label}" — ${Object.keys(current).length} fields.`, 'success');
  renderList(sessions, pathname);
}

async function startReplay(session, pathname) {
  // Filter out excluded fields before sending
  const excluded = new Set(session.excluded || []);
  const filteredData = Object.fromEntries(
    Object.entries(session.data).filter(([key]) => !excluded.has(key))
  );

  const tab = await getTab();
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'START_REPLAY', data: filteredData });
    setActiveReplay(session);
    const skipped = excluded.size;
    const msg = skipped > 0
      ? `Replay started — ${skipped} field${skipped > 1 ? 's' : ''} skipped.`
      : `Replay started for "${session.label}".`;
    setStatus(msg, 'success');
    renderList(await loadSessions(pathname), pathname);
  } catch {
    setStatus('Could not connect to page. Reload the form tab.', 'error');
  }
}

async function stopReplay(pathname) {
  const tab = await getTab();
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'STOP_REPLAY' });
  } catch {
    // ignore — tab may have navigated
  }
  setActiveReplay(null);
  setStatus('Replay stopped.', 'default');
  renderList(await loadSessions(pathname), pathname);
}

async function deleteSession(id, pathname) {
  let sessions = await loadSessions(pathname);
  sessions = sessions.filter((s) => s.id !== id);
  await saveSessions(pathname, sessions);

  if (openPanelId === id) openPanelId = null;

  if (activeReplayId === id) {
    await stopReplay(pathname);
  } else {
    setStatus('Journey deleted.', 'default');
    renderList(sessions, pathname);
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  const tab = await getTab();
  const url = new URL(tab.url);
  const pathname = url.pathname;

  const sessions = await loadSessions(pathname);
  renderList(sessions, pathname);

  document.getElementById('btnSave').addEventListener('click', () => saveJourney(pathname));

  document.getElementById('journeyName').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveJourney(pathname);
  });

  document.getElementById('btnStopReplay').addEventListener('click', () => stopReplay(pathname));

  // Copy sheet
  document.getElementById('sheetOverlay').addEventListener('click', closeCopyPanel);
  document.getElementById('btnCloseSheet').addEventListener('click', closeCopyPanel);
  document.getElementById('btnCopyJSON').addEventListener('click', copyFieldsToClipboard);

  document.getElementById('copyFieldList').addEventListener('change', updateCopyCount);

  document.getElementById('btnSelectAll').addEventListener('click', () => {
    const checkboxes = document.querySelectorAll('#copyFieldList input[type="checkbox"]');
    const allChecked = [...checkboxes].every(cb => cb.checked);
    checkboxes.forEach(cb => { cb.checked = !allChecked; });
    updateCopyCount();
  });
}

init();
