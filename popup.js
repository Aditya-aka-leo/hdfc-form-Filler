// ─── Config ───────────────────────────────────────────────────────────────────

const API_BASE = 'http://localhost:3001/api/v1';

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

/** Show a human-friendly creator name — hide raw UUIDs */
function displayCreator(createdBy) {
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidPattern.test(createdBy) ? 'Anonymous' : createdBy;
}

let statusTimer = null;

function setStatus(msg, type = 'default') {
  const bar = document.getElementById('statusBar');
  bar.textContent = msg;
  bar.className = type === 'error' ? 'error' : type === 'success' ? 'success' : '';
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { bar.textContent = ''; bar.className = ''; }, 3000);
}

// ─── Identity ─────────────────────────────────────────────────────────────────

async function getOrCreateDeviceId() {
  const result = await chrome.storage.local.get('deviceId');
  if (result.deviceId) return result.deviceId;
  const id = uuid();
  await chrome.storage.local.set({ deviceId: id });
  return id;
}

async function getUserName() {
  const result = await chrome.storage.local.get('userName');
  return result.userName || '';
}

async function saveUserName(name) {
  await chrome.storage.local.set({ userName: name });
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

// ─── API ──────────────────────────────────────────────────────────────────────

async function apiFetch(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

async function loadSessions(pathname) {
  // Always load locally saved (offline) sessions first
  const allLocal = await chrome.storage.local.get(null);
  const localSessions = Object.entries(allLocal)
    .filter(([k]) => k.startsWith('local_'))
    .map(([, v]) => v)
    .filter(s => s.pathname === pathname)
    .map(s => ({ ...s, _local: true }));

  try {
    const { sessions } = await apiFetch(`/sessions?pathname=${encodeURIComponent(pathname)}`);
    const keys = sessions.map(s => `steps_${s.id}`);
    const stored = keys.length ? await chrome.storage.local.get(keys) : {};
    const apiSessions = sessions.map(s => ({
      ...s,
      steps: (s.steps && s.steps.length) ? s.steps : (stored[`steps_${s.id}`] || []),
    }));
    // Include local sessions that haven't been synced yet (not already in API response)
    const apiIds = new Set(apiSessions.map(s => s.id));
    const unsynced = localSessions.filter(s => !apiIds.has(s.id));
    return [...apiSessions, ...unsynced];
  } catch {
    if (localSessions.length) {
      setStatus('Server offline — showing local saves.', 'default');
    } else {
      setStatus('Could not reach server.', 'error');
    }
    return localSessions;
  }
}

// ─── Copy Sheet ──────────────────────────────────────────────────────────────

let copyData = null;

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

function buildFieldPanel(session) {
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
      await toggleExclusion(session, key, e.target.checked);
    });

    list.appendChild(row);
  });

  panel.appendChild(list);
  return panel;
}

async function toggleExclusion(session, fieldName, isEnabled) {
  if (!session.excluded) session.excluded = [];

  if (isEnabled) {
    session.excluded = session.excluded.filter(f => f !== fieldName);
  } else if (!session.excluded.includes(fieldName)) {
    session.excluded.push(fieldName);
  }

  try {
    await apiFetch(`/sessions/${session.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ excluded: session.excluded }),
    });
  } catch (err) {
    setStatus(`Failed to update fields: ${err.message}`, 'error');
    return;
  }

  const countEl = document.getElementById(`panel-count-${session.id}`);
  if (countEl) {
    const total = Object.keys(session.data).length;
    countEl.textContent = `${total - session.excluded.length} of ${total} will prefill`;
  }
}

// ─── Render journey list ──────────────────────────────────────────────────────

function renderList(sessions, pathname, deviceId) {
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
    const isOwn = session.createdBy === deviceId;
    const isLocal = !!session._local;

    const item = document.createElement('div');
    item.className = 'journey-item';

    const creatorTag = isLocal
      ? `<span class="creator-pill" style="background:var(--orange-dim);color:var(--orange)">local</span>`
      : (!isOwn ? `<span class="creator-pill">${session.displayName || displayCreator(session.createdBy)}</span>` : '');

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
          ${session.steps && session.steps.length ? `<span class="field-pill" title="Has step recording">${session.steps.length} steps</span>` : ''}
          ${creatorTag}
        </div>
        <div class="journey-sub-actions"></div>
      </div>
    `;

    const actions = item.querySelector('.journey-sub-actions');

    // Configure button
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
      document.querySelectorAll('.field-panel').forEach(p => p.remove());
      document.querySelectorAll('.btn-active').forEach(b => b.classList.remove('btn-active'));

      if (openPanelId === session.id) {
        openPanelId = null;
      } else {
        openPanelId = session.id;
        btnConfigure.classList.add('btn-active');
        const panel = buildFieldPanel(session);
        item.insertAdjacentElement('afterend', panel);
      }
    });

    // Share button — for local (offline) saves: uploads whole session to server
    if (isLocal) {
      const btnShare = document.createElement('button');
      btnShare.className = 'btn btn-accent btn-sm';
      btnShare.title = 'Upload to server so teammates can use it';
      btnShare.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width:11px;height:11px"><polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0018 9h-1.26A8 8 0 103 16.3"/></svg> Share`;
      btnShare.addEventListener('click', () => shareSession(session, pathname, deviceId));
      actions.appendChild(btnShare);
    }


    // Replay Journey button (step replay) — only shown when steps are recorded
    if (session.steps && session.steps.length > 0) {
      const btnReplay = document.createElement('button');
      btnReplay.className = 'btn btn-accent btn-sm';
      btnReplay.title = 'Replay full journey (step-by-step)';
      btnReplay.disabled = isActive;
      btnReplay.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width:11px;height:11px"><polygon points="5 3 19 12 5 21 5 3" fill="currentColor" stroke="none"/></svg> Replay`;
      btnReplay.addEventListener('click', () => startReplay(session, pathname, deviceId, 'steps'));
      actions.appendChild(btnReplay);
    }

    // Prefill Data button — always available
    const btnPrefill = document.createElement('button');
    btnPrefill.className = 'btn btn-ghost btn-sm';
    btnPrefill.title = 'Prefill form fields only';
    btnPrefill.disabled = isActive;
    btnPrefill.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width:11px;height:11px"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg> Prefill`;
    btnPrefill.addEventListener('click', () => startReplay(session, pathname, deviceId, 'prefill'));
    actions.appendChild(btnPrefill);

    // Delete — only for sessions you own
    if (isOwn) {
      const btnDelete = document.createElement('button');
      btnDelete.className = 'btn btn-danger-ghost btn-sm btn-icon';
      btnDelete.title = 'Delete';
      btnDelete.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>`;
      btnDelete.addEventListener('click', () => deleteSession(session.id, pathname, deviceId));
      actions.appendChild(btnDelete);
    }

    actions.appendChild(btnConfigure);
    list.appendChild(item);

    if (isPanelOpen) {
      const panel = buildFieldPanel(session);
      list.appendChild(panel);
    }
  });
}

// ─── Actions ──────────────────────────────────────────────────────────────────

async function getTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function saveJourney(pathname, deviceId) {
  const nameInput = document.getElementById('journeyName');
  const label = nameInput.value.trim();
  if (!label) {
    setStatus('Please enter a journey name.', 'error');
    nameInput.focus();
    return;
  }

  const userNameInput = document.getElementById('userName');
  const displayName = userNameInput ? userNameInput.value.trim() : '';

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

  const session = {
    id: uuid(),
    label,
    savedAt: new Date().toISOString(),
    pathname,
    data: current,
    excluded: [],
    createdBy: deviceId,
    displayName: displayName || null,
  };

  let steps = [];
  const shareWithTeam = document.getElementById('shareStepsToggle')?.checked;
  try {
    const stepsResponse = await chrome.tabs.sendMessage(tab.id, { type: 'GET_STEPS' });
    steps = stepsResponse.steps || [];
  } catch { /* ignore */ }

  // Toggle OFF → save locally only, no DB. User can share later via the Share button.
  if (!shareWithTeam) {
    const localSession = { ...session, steps, _local: true };
    await chrome.storage.local.set({ [`local_${session.id}`]: localSession });
    nameInput.value = '';
    setStatus(`"${label}" saved locally. Enable "Share steps with team" to share.`, 'default');
    const sessions = await loadSessions(pathname);
    renderList(sessions, pathname, deviceId);
    return;
  }

  // Toggle ON → save to DB with steps so teammates can replay
  if (steps.length) session.steps = steps;

  try {
    await apiFetch('/sessions', {
      method: 'POST',
      body: JSON.stringify(session),
    });
    nameInput.value = '';
    setStatus(`Saved & shared "${label}" — ${Object.keys(current).length} fields.`, 'success');
    const sessions = await loadSessions(pathname);
    renderList(sessions, pathname, deviceId);
  } catch {
    // Server offline — save everything locally so no work is lost
    const localSession = { ...session, steps, _local: true };
    await chrome.storage.local.set({ [`local_${session.id}`]: localSession });
    nameInput.value = '';
    setStatus(`Server offline — "${label}" saved locally. Share it later.`, 'default');
    const sessions = await loadSessions(pathname);
    renderList(sessions, pathname, deviceId);
  }
}

async function startReplay(session, pathname, deviceId, mode = 'prefill') {
  const tab = await getTab();
  try {
    if (mode === 'steps' && session.steps && session.steps.length > 0) {
      await chrome.tabs.sendMessage(tab.id, { type: 'START_STEP_REPLAY', steps: session.steps });
      setActiveReplay(session);
      setStatus(`Replay started — ${session.steps.length} steps.`, 'success');
    } else {
      const excluded = new Set(session.excluded || []);
      const filteredData = Object.fromEntries(
        Object.entries(session.data).filter(([key]) => !excluded.has(key))
      );
      await chrome.tabs.sendMessage(tab.id, { type: 'START_REPLAY', data: filteredData });
      setActiveReplay(session);
      const skipped = excluded.size;
      const msg = skipped > 0
        ? `Prefill started — ${skipped} field${skipped > 1 ? 's' : ''} skipped.`
        : `Prefill started for "${session.label}".`;
      setStatus(msg, 'success');
    }
    const sessions = await loadSessions(pathname);
    renderList(sessions, pathname, deviceId);
  } catch {
    setStatus('Could not connect to page. Reload the form tab.', 'error');
  }
}

async function stopReplay(pathname, deviceId) {
  const tab = await getTab();
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'STOP_REPLAY' });
    await chrome.tabs.sendMessage(tab.id, { type: 'STOP_STEP_REPLAY' });
  } catch {
    // ignore — tab may have navigated
  }
  setActiveReplay(null);
  setStatus('Replay stopped.', 'default');
  const sessions = await loadSessions(pathname);
  renderList(sessions, pathname, deviceId);
}

async function shareSession(session, pathname, deviceId) {
  try {
    const sessionToShare = { ...session };
    delete sessionToShare._local;
    await apiFetch('/sessions', { method: 'POST', body: JSON.stringify(sessionToShare) });
    // Uploaded — remove local copy
    await chrome.storage.local.remove(`local_${session.id}`);
    setStatus(`"${session.label}" shared with team.`, 'success');
    const sessions = await loadSessions(pathname);
    renderList(sessions, pathname, deviceId);
  } catch (err) {
    setStatus(`Share failed: ${err.message}`, 'error');
  }
}


async function deleteSession(id, pathname, deviceId) {
  // Local-only session — just remove from chrome.storage.local
  const localKey = `local_${id}`;
  const stored = await chrome.storage.local.get(localKey);
  if (stored[localKey]) {
    await chrome.storage.local.remove(localKey);
    setStatus('Journey deleted.', 'default');
    const sessions = await loadSessions(pathname);
    renderList(sessions, pathname, deviceId);
    return;
  }

  try {
    await apiFetch(`/sessions/${id}`, { method: 'DELETE' });
  } catch (err) {
    setStatus(`Delete failed: ${err.message}`, 'error');
    return;
  }
  chrome.storage.local.remove(`steps_${id}`);

  if (openPanelId === id) openPanelId = null;

  if (activeReplayId === id) {
    await stopReplay(pathname, deviceId);
  } else {
    setStatus('Journey deleted.', 'default');
    const sessions = await loadSessions(pathname);
    renderList(sessions, pathname, deviceId);
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  const deviceId = await getOrCreateDeviceId();
  const tab = await getTab();
  const url = new URL(tab.url);
  const pathname = url.pathname;

  // Restore saved user name
  const savedName = await getUserName();
  const userNameInput = document.getElementById('userName');
  if (userNameInput && savedName) userNameInput.value = savedName;
  if (userNameInput) {
    userNameInput.addEventListener('blur', () => saveUserName(userNameInput.value.trim()));
  }

  // Restore share-steps toggle preference
  const shareStepsToggle = document.getElementById('shareStepsToggle');
  if (shareStepsToggle) {
    const { shareSteps } = await chrome.storage.local.get('shareSteps');
    shareStepsToggle.checked = !!shareSteps;
    shareStepsToggle.addEventListener('change', () => {
      chrome.storage.local.set({ shareSteps: shareStepsToggle.checked });
    });
  }

  const sessions = await loadSessions(pathname);
  renderList(sessions, pathname, deviceId);

  // ── URL pattern management ──────────────────────────────────────────────────
  let allowedPatterns = [];

  const renderPatterns = () => {
    const list = document.getElementById('urlPatternList');
    list.innerHTML = '';
    allowedPatterns.forEach((p, i) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;';
      row.innerHTML = `
        <span style="flex:1;font-size:11px;color:var(--text);font-family:monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${p}">${p}</span>
        <button class="btn btn-danger-ghost btn-sm" data-i="${i}" style="flex-shrink:0;padding:3px 7px;">✕</button>
      `;
      row.querySelector('button').addEventListener('click', async () => {
        allowedPatterns.splice(i, 1);
        await chrome.storage.local.set({ allowedPatterns });
        renderPatterns();
      });
      list.appendChild(row);
    });
  };

  const { allowedPatterns: stored } = await chrome.storage.local.get('allowedPatterns');
  allowedPatterns = stored || [];
  renderPatterns();

  document.getElementById('btnAddUrl').addEventListener('click', async () => {
    const input = document.getElementById('urlPatternInput');
    const val = input.value.trim();
    if (!val) return;
    if (!allowedPatterns.includes(val)) {
      allowedPatterns.push(val);
      await chrome.storage.local.set({ allowedPatterns });
      renderPatterns();
    }
    input.value = '';
  });

  document.getElementById('urlPatternInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('btnAddUrl').click();
  });

  document.getElementById('btnSave').addEventListener('click', () => saveJourney(pathname, deviceId));

  document.getElementById('journeyName').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveJourney(pathname, deviceId);
  });

  document.getElementById('btnStopReplay').addEventListener('click', () => stopReplay(pathname, deviceId));

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
