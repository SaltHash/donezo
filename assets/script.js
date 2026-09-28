'use strict';

/* =========================================================================
   STATE
   ========================================================================= */
let tasks = JSON.parse(localStorage.getItem('todo_v3_tasks') || '[]');
let recurring = JSON.parse(localStorage.getItem('todo_v3_recurring') || '[]');
let stats = JSON.parse(localStorage.getItem('todo_v3_stats') || 'null') || {
  totalCompleted: 0, totalAdded: 0, currentStreak: 0, lastActiveDate: null
};

let searchQuery = '';
let anytimeExpanded = false;

// Routine editor (week-builder) state
let editingRuleId = null;
let draftGroups = []; // [{start, end}] in Monday-first day indices (0=Mon .. 6=Sun)
let dragState = null;

const DAY_LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const THEME_FAMILIES = [
  { id: 'graphite', name: 'Graphite' },
  { id: 'gruvbox', name: 'Gruvbox' },
  { id: 'catppuccin', name: 'Catppuccin' },
  { id: 'ayu', name: 'Ayu' },
  { id: 'nord', name: 'Nord' },
  { id: 'rosepine', name: 'Rosé Pine' }
];

/* =========================================================================
   DATE HELPERS
   ========================================================================= */
function getLocalISODate(dateObj) {
  const offset = dateObj.getTimezoneOffset();
  return new Date(dateObj.getTime() - offset * 60 * 1000).toISOString().split('T')[0];
}

function parseISODateLocal(dateStr) {
  return new Date(dateStr + 'T00:00:00');
}

function addDays(dateStr, delta) {
  const d = parseISODateLocal(dateStr);
  d.setDate(d.getDate() + delta);
  return getLocalISODate(d);
}

function mondayFirstIndex(dateObj) {
  return (dateObj.getDay() + 6) % 7;
}

function formatHumanDate(dateStr) {
  const d = parseISODateLocal(dateStr);
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}

function genId(prefix) {
  if (window.crypto && crypto.randomUUID) return `${prefix}_${crypto.randomUUID()}`;
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/* =========================================================================
   PERSISTENCE
   ========================================================================= */
function saveState() {
  localStorage.setItem('todo_v3_tasks', JSON.stringify(tasks));
  localStorage.setItem('todo_v3_recurring', JSON.stringify(recurring));
  localStorage.setItem('todo_v3_stats', JSON.stringify(stats));
}

/* =========================================================================
   THEME
   ========================================================================= */
function initTheme() {
  const select = document.getElementById('theme-family-select');
  select.innerHTML = '';
  THEME_FAMILIES.forEach(f => {
    const opt = document.createElement('option');
    opt.value = f.id;
    opt.textContent = f.name;
    select.appendChild(opt);
  });

  const storedFamily = localStorage.getItem('todo_v3_theme_family');
  const storedMode = localStorage.getItem('todo_v3_mode');
  const family = (storedFamily && THEME_FAMILIES.some(f => f.id === storedFamily)) ? storedFamily : 'graphite';
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const mode = storedMode || (prefersDark ? 'dark' : 'light');

  applyTheme(family, mode);
  select.value = family;

  select.addEventListener('change', () => {
    applyTheme(select.value, document.documentElement.getAttribute('data-mode'));
  });

  document.getElementById('mode-toggle').addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-mode');
    applyTheme(document.documentElement.getAttribute('data-theme-family'), current === 'dark' ? 'light' : 'dark');
  });
}

function applyTheme(family, mode) {
  document.documentElement.setAttribute('data-theme-family', family);
  document.documentElement.setAttribute('data-mode', mode);
  document.getElementById('mode-toggle').setAttribute('aria-pressed', String(mode === 'dark'));
  localStorage.setItem('todo_v3_theme_family', family);
  localStorage.setItem('todo_v3_mode', mode);
}

/* =========================================================================
   TOASTS (used for delete-undo and small validation messages)
   ========================================================================= */
function showToast(message, onUndo) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = 'toast';

  const span = document.createElement('span');
  span.textContent = message;
  toast.appendChild(span);

  let dismissed = false;
  const remove = () => {
    if (dismissed) return;
    dismissed = true;
    toast.classList.add('leaving');
    setTimeout(() => toast.remove(), 150);
  };

  if (onUndo) {
    const btn = document.createElement('button');
    btn.className = 'toast-undo';
    btn.type = 'button';
    btn.textContent = 'Undo';
    btn.addEventListener('click', () => { remove(); onUndo(); });
    toast.appendChild(btn);
  }

  container.appendChild(toast);
  setTimeout(remove, 5000);
}

/* =========================================================================
   TASK ITEM RENDERING (DOM built directly — no innerHTML with user text,
   so task titles can never be interpreted as markup)
   ========================================================================= */
function buildTaskItem(task, opts) {
  opts = opts || {};
  const li = document.createElement('li');
  li.className = 'task-item' + (task.completed ? ' completed' : '');
  li.dataset.id = task.id;

  const content = document.createElement('div');
  content.className = 'task-content';

  const checkboxLabel = document.createElement('label');
  checkboxLabel.className = 'checkbox-wrapper';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = task.completed;
  checkbox.dataset.role = 'toggle';
  const checkmark = document.createElement('span');
  checkmark.className = 'checkmark';
  checkboxLabel.appendChild(checkbox);
  checkboxLabel.appendChild(checkmark);

  const textSpan = document.createElement('span');
  const editable = task.type !== 'routine';
  textSpan.className = 'task-text' + (editable ? '' : ' not-editable');
  textSpan.textContent = task.text;
  if (editable) {
    textSpan.dataset.role = 'text';
    textSpan.tabIndex = 0;
    textSpan.title = 'Click to edit';
  } else {
    textSpan.title = 'Generated by a routine — edit it from Routines';
  }

  content.appendChild(checkboxLabel);
  content.appendChild(textSpan);

  if (opts.badge) {
    const badge = document.createElement('span');
    badge.className = 'badge cycle';
    badge.textContent = opts.badge;
    content.appendChild(badge);
  }

  const delBtn = document.createElement('button');
  delBtn.className = 'delete-btn';
  delBtn.type = 'button';
  delBtn.dataset.role = 'delete';
  delBtn.setAttribute('aria-label', 'Delete task');
  delBtn.textContent = '\u00d7';

  li.appendChild(content);
  li.appendChild(delBtn);
  return li;
}

function buildEmptyState(text) {
  const li = document.createElement('li');
  li.className = 'empty-state';
  li.textContent = text;
  return li;
}

function setupTaskListDelegation(listEl) {
  listEl.addEventListener('change', e => {
    if (e.target.matches('[data-role="toggle"]')) {
      const li = e.target.closest('.task-item');
      toggleTask(li.dataset.id, e.target.checked);
    }
  });
  listEl.addEventListener('click', e => {
    const delBtn = e.target.closest('[data-role="delete"]');
    if (delBtn) {
      const li = delBtn.closest('.task-item');
      deleteTaskWithUndo(li.dataset.id);
      return;
    }
    const textEl = e.target.closest('[data-role="text"]');
    if (textEl) {
      const li = textEl.closest('.task-item');
      const task = tasks.find(t => t.id === li.dataset.id);
      if (task) startEditTask(li, task);
    }
  });
}

function startEditTask(li, task) {
  const span = li.querySelector('[data-role="text"]');
  if (!span) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'task-text-input';
  input.value = task.text;
  input.maxLength = 200;
  span.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const commit = () => {
    if (done) return;
    done = true;
    const val = input.value.trim();
    if (val) task.text = val;
    saveState();
    renderAll();
  };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    else if (e.key === 'Escape') { done = true; renderAll(); }
  });
}

/* =========================================================================
   TASK ACTIONS
   ========================================================================= */
function addTask() {
  const textInput = document.getElementById('new-task-text');
  const text = textInput.value.trim();
  if (!text) return;

  const type = document.getElementById('new-task-type').value;
  const dateStr = document.getElementById('add-task-date').value;

  tasks.push({
    id: genId('task'),
    type: type,
    text: text,
    date: type === 'date' ? dateStr : null,
    completed: false
  });

  stats.totalAdded++;
  textInput.value = '';
  textInput.focus();
  saveState();
  renderAll();
}

function toggleTask(id, isCompleted) {
  const task = tasks.find(t => t.id === id);
  if (!task) return;
  task.completed = isCompleted;
  if (isCompleted) {
    stats.totalCompleted++;
    updateStreak();
  } else {
    stats.totalCompleted = Math.max(0, stats.totalCompleted - 1);
  }
  saveState();
  renderAll();
}

function deleteTaskWithUndo(id) {
  const idx = tasks.findIndex(t => t.id === id);
  if (idx === -1) return;
  const [removed] = tasks.splice(idx, 1);
  saveState();
  renderAll();
  showToast('Task deleted', () => {
    tasks.splice(idx, 0, removed);
    saveState();
    renderAll();
  });
}

/* =========================================================================
   STATS & STREAK
   ========================================================================= */
function updateStreak() {
  const todayStr = getLocalISODate(new Date());
  if (!stats.lastActiveDate) {
    stats.currentStreak = 1;
  } else if (stats.lastActiveDate !== todayStr) {
    const yesterdayStr = addDays(todayStr, -1);
    stats.currentStreak = (stats.lastActiveDate === yesterdayStr) ? stats.currentStreak + 1 : 1;
  }
  stats.lastActiveDate = todayStr;
}

function updateStatsUI() {
  document.getElementById('stat-completed').textContent = stats.totalCompleted;
  document.getElementById('stat-added').textContent = stats.totalAdded;
  document.getElementById('stat-streak').textContent = stats.currentStreak;
  const rate = stats.totalAdded > 0 ? Math.round((stats.totalCompleted / stats.totalAdded) * 100) : 0;
  document.getElementById('stat-rate').textContent = `${Math.min(rate, 100)}%`;
}

/* =========================================================================
   RENDERING — Anytime (permanent) tasks and the current day's tasks are
   deliberately kept in separate sections: they behave differently
   (Anytime tasks aren't tied to a date at all), and mixing them together
   was the single most confusing part of the previous version.
   ========================================================================= */
function renderAnytimeList() {
  const section = document.getElementById('anytime-section');
  const all = tasks.filter(t => t.type === 'permanent');

  if (all.length === 0) {
    section.hidden = true;
    return;
  }
  section.hidden = false;

  let filtered = all;
  if (searchQuery) filtered = filtered.filter(t => t.text.toLowerCase().includes(searchQuery));

  const active = filtered.filter(t => !t.completed);
  const done = filtered.filter(t => t.completed);

  const toggleBtn = document.getElementById('anytime-completed-toggle');
  if (done.length === 0) {
    toggleBtn.hidden = true;
  } else {
    toggleBtn.hidden = false;
    toggleBtn.textContent = (anytimeExpanded ? 'Hide ' : 'Show ') + done.length + ' completed';
  }

  const list = document.getElementById('anytime-list');
  list.innerHTML = '';
  if (active.length === 0 && !(anytimeExpanded && done.length > 0)) {
    list.appendChild(buildEmptyState(searchQuery ? 'No matching tasks.' : 'Nothing anytime right now.'));
  } else {
    active.forEach(t => list.appendChild(buildTaskItem(t)));
    if (anytimeExpanded) done.forEach(t => list.appendChild(buildTaskItem(t)));
  }
}

function renderDayList() {
  const viewDateStr = document.getElementById('view-date').value;
  const viewDate = parseISODateLocal(viewDateStr);
  const wd = mondayFirstIndex(viewDate);
  const expectedIds = [];
  let createdNew = false;

  // Lazily materialize a task instance for any routine whose group covers
  // this weekday. All days in the same group share one id (anchored to the
  // group's first day), so they share one completion state for the week.
  recurring.forEach(rule => {
    rule.groups.forEach(g => {
      if (wd >= g.start && wd <= g.end) {
        const offset = wd - g.start;
        const cycleStart = addDays(viewDateStr, -offset);
        const cycleId = `rt_${rule.id}_${cycleStart}`;
        expectedIds.push(cycleId);
        if (!tasks.find(t => t.id === cycleId)) {
          tasks.push({ id: cycleId, type: 'routine', ruleId: rule.id, text: rule.text, date: cycleStart, completed: false });
          createdNew = true;
        }
      }
    });
  });

  let visible = tasks.filter(t =>
    (t.type === 'date' && t.date === viewDateStr) ||
    (t.type === 'routine' && expectedIds.includes(t.id))
  );

  if (searchQuery) visible = visible.filter(t => t.text.toLowerCase().includes(searchQuery));

  visible.sort((a, b) => Number(a.completed) - Number(b.completed));

  const todayStr = getLocalISODate(new Date());
  const isToday = viewDateStr === todayStr;
  document.getElementById('day-heading').textContent = (isToday ? 'Today \u2014 ' : '') + formatHumanDate(viewDateStr);

  const label = document.getElementById('view-date-label');
  label.textContent = 'Today';
  label.style.display = isToday ? 'inline' : 'none';

  const list = document.getElementById('task-list');
  list.innerHTML = '';
  if (visible.length === 0) {
    list.appendChild(buildEmptyState(searchQuery ? 'No matching tasks.' : 'Nothing scheduled \u2014 enjoy the free time.'));
  } else {
    visible.forEach(t => list.appendChild(buildTaskItem(t, { badge: t.type === 'routine' ? 'Routine' : null })));
  }

  if (createdNew) saveState();
}

function renderAll() {
  renderDayList();
  renderAnytimeList();
  updateStatsUI();
}

/* =========================================================================
   VIEW-DATE NAVIGATION & ADD-TASK PANEL
   ========================================================================= */
function syncAddDateDefault() {
  if (document.getElementById('new-task-type').value === 'date') {
    document.getElementById('add-task-date').value = document.getElementById('view-date').value;
  }
}

function updateAddTypeHint() {
  const type = document.getElementById('new-task-type').value;
  document.getElementById('add-type-hint').textContent = type === 'permanent'
    ? 'Shows up in Anytime, every day, until you check it off.'
    : 'Shows up only on the date you pick.';
}

function onViewDateChange() {
  syncAddDateDefault();
  renderAll();
}

function shiftViewDate(delta) {
  const input = document.getElementById('view-date');
  input.value = addDays(input.value, delta);
  onViewDateChange();
}

/* =========================================================================
   WEEK BUILDER — manual, drag/resize routine-day grouping widget
   ========================================================================= */
function findBlockForIndex(idx) {
  for (let i = 0; i < draftGroups.length; i++) {
    const g = draftGroups[i];
    if (idx >= g.start && idx <= g.end) return i;
  }
  return -1;
}

function computeBounds(anchorIdx, excludeIndex) {
  let left = 0, right = 6;
  draftGroups.forEach((g, i) => {
    if (i === excludeIndex) return;
    if (g.end < anchorIdx) left = Math.max(left, g.end + 1);
    if (g.start > anchorIdx) right = Math.min(right, g.start - 1);
  });
  return { left, right };
}

function formatGroups(groups) {
  return groups.slice().sort((a, b) => a.start - b.start)
    .map(g => g.start === g.end ? DAY_NAMES[g.start] : `${DAY_NAMES[g.start]}\u2013${DAY_NAMES[g.end]}`)
    .join(' \u00b7 ');
}

function renderWeekBuilder() {
  const track = document.getElementById('week-track');
  track.innerHTML = '';
  for (let i = 0; i < 7; i++) {
    const cell = document.createElement('div');
    cell.className = 'week-cell';
    cell.dataset.index = String(i);
    cell.title = DAY_NAMES[i];

    const dayLabel = document.createElement('span');
    dayLabel.className = 'week-cell-day';
    dayLabel.textContent = DAY_LETTERS[i];
    cell.appendChild(dayLabel);

    const blockIndex = findBlockForIndex(i);
    if (blockIndex !== -1) {
      cell.classList.add('filled');
      cell.dataset.block = String(blockIndex % 4);
      const g = draftGroups[blockIndex];
      if (i === g.start) {
        const h = document.createElement('span');
        h.className = 'week-resize-handle left';
        h.dataset.handle = 'left';
        h.dataset.blockIndex = String(blockIndex);
        cell.appendChild(h);
      }
      if (i === g.end) {
        const h = document.createElement('span');
        h.className = 'week-resize-handle right';
        h.dataset.handle = 'right';
        h.dataset.blockIndex = String(blockIndex);
        cell.appendChild(h);
      }
    }
    track.appendChild(cell);
  }

  const summary = document.getElementById('week-builder-summary');
  summary.textContent = draftGroups.length === 0 ? 'No days selected yet.' : formatGroups(draftGroups);
}

function cellIndexFromClientX(clientX) {
  const track = document.getElementById('week-track');
  const rect = track.getBoundingClientRect();
  const cellWidth = rect.width / 7;
  const idx = Math.floor((clientX - rect.left) / cellWidth);
  return Math.max(0, Math.min(6, idx));
}

function onWeekPointerDown(e) {
  const handle = e.target.closest('[data-handle]');
  const cell = e.target.closest('.week-cell');
  if (!handle && !cell) return;
  e.preventDefault();

  if (handle) {
    const blockIndex = parseInt(handle.dataset.blockIndex, 10);
    const mode = handle.dataset.handle === 'left' ? 'resize-left' : 'resize-right';
    const g = draftGroups[blockIndex];
    const bounds = mode === 'resize-left'
      ? { left: computeBounds(g.end, blockIndex).left, right: g.end }
      : { left: g.start, right: computeBounds(g.start, blockIndex).right };
    dragState = { mode, blockIndex, bounds, startIdx: cellIndexFromClientX(e.clientX), moved: false };
  } else {
    const idx = parseInt(cell.dataset.index, 10);
    const existingBlock = findBlockForIndex(idx);
    if (existingBlock !== -1) {
      dragState = { mode: 'remove-candidate', blockIndex: existingBlock, startIdx: idx, moved: false };
    } else {
      draftGroups.push({ start: idx, end: idx });
      const blockIndex = draftGroups.length - 1;
      const bounds = computeBounds(idx, blockIndex);
      dragState = { mode: 'create', anchor: idx, blockIndex, bounds, startIdx: idx, moved: false };
      renderWeekBuilder();
    }
  }

  window.addEventListener('pointermove', onWeekPointerMove);
  window.addEventListener('pointerup', onWeekPointerUp, { once: true });
}

function onWeekPointerMove(e) {
  if (!dragState) return;
  const idx = cellIndexFromClientX(e.clientX);
  if (idx !== dragState.startIdx) dragState.moved = true;

  if (dragState.mode === 'create') {
    const g = draftGroups[dragState.blockIndex];
    g.start = Math.max(dragState.bounds.left, Math.min(dragState.anchor, idx));
    g.end = Math.min(dragState.bounds.right, Math.max(dragState.anchor, idx));
    renderWeekBuilder();
  } else if (dragState.mode === 'resize-left') {
    const g = draftGroups[dragState.blockIndex];
    g.start = Math.max(dragState.bounds.left, Math.min(idx, dragState.bounds.right));
    renderWeekBuilder();
  } else if (dragState.mode === 'resize-right') {
    const g = draftGroups[dragState.blockIndex];
    g.end = Math.min(dragState.bounds.right, Math.max(idx, dragState.bounds.left));
    renderWeekBuilder();
  }
}

function onWeekPointerUp() {
  window.removeEventListener('pointermove', onWeekPointerMove);
  if (!dragState) return;
  if (dragState.mode === 'remove-candidate' && !dragState.moved) {
    draftGroups.splice(dragState.blockIndex, 1);
    renderWeekBuilder();
  }
  dragState = null;
}

/* =========================================================================
   ROUTINE (RECURRING RULE) ACTIONS
   ========================================================================= */
function resetRoutineForm() {
  editingRuleId = null;
  draftGroups = [];
  document.getElementById('rec-task-text').value = '';
  document.getElementById('save-routine-btn').textContent = 'Add routine';
  document.getElementById('cancel-edit-btn').hidden = true;
  document.getElementById('routine-form-label').textContent = 'New routine';
  renderWeekBuilder();
}

function startEditRoutine(ruleId) {
  const rule = recurring.find(r => r.id === ruleId);
  if (!rule) return;
  editingRuleId = ruleId;
  draftGroups = rule.groups.map(g => ({ start: g.start, end: g.end }));
  document.getElementById('rec-task-text').value = rule.text;
  document.getElementById('save-routine-btn').textContent = 'Update routine';
  document.getElementById('cancel-edit-btn').hidden = false;
  document.getElementById('routine-form-label').textContent = 'Edit routine';
  renderWeekBuilder();
  document.getElementById('rec-task-text').focus();
}

function saveRoutine() {
  const textInput = document.getElementById('rec-task-text');
  const text = textInput.value.trim();
  if (!text) { showToast('Give the routine a name first.'); return; }
  if (draftGroups.length === 0) { showToast('Pick at least one day.'); return; }

  const groups = draftGroups.map(g => ({ start: g.start, end: g.end })).sort((a, b) => a.start - b.start);

  if (editingRuleId) {
    const rule = recurring.find(r => r.id === editingRuleId);
    rule.text = text;
    rule.groups = groups;
    // Drop not-yet-completed instances so the new pattern regenerates cleanly;
    // completed history for this rule is left untouched.
    tasks = tasks.filter(t => !(t.type === 'routine' && t.ruleId === rule.id && !t.completed));
  } else {
    recurring.push({ id: genId('rule'), text, groups });
    stats.totalAdded++;
  }

  resetRoutineForm();
  saveState();
  renderRecurringSettings();
  renderAll();
}

function deleteRecurringWithUndo(ruleId) {
  const ruleIdx = recurring.findIndex(r => r.id === ruleId);
  if (ruleIdx === -1) return;
  const [rule] = recurring.splice(ruleIdx, 1);
  const removedTasks = [];
  tasks = tasks.filter(t => {
    if (t.type === 'routine' && t.ruleId === ruleId) { removedTasks.push(t); return false; }
    return true;
  });
  if (editingRuleId === ruleId) resetRoutineForm();

  saveState();
  renderRecurringSettings();
  renderAll();
  showToast(`"${rule.text}" deleted`, () => {
    recurring.splice(ruleIdx, 0, rule);
    tasks.push(...removedTasks);
    saveState();
    renderRecurringSettings();
    renderAll();
  });
}

function renderRecurringSettings() {
  const list = document.getElementById('recurring-list');
  list.innerHTML = '';
  if (recurring.length === 0) {
    list.appendChild(buildEmptyState('No routines yet \u2014 add one above.'));
    return;
  }
  recurring.forEach(rule => {
    const li = document.createElement('li');
    li.className = 'task-item routine-row';

    const top = document.createElement('div');
    top.className = 'routine-row-top';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'task-text';
    nameSpan.style.fontWeight = '500';
    nameSpan.textContent = rule.text;

    const actions = document.createElement('div');
    actions.className = 'routine-row-actions';

    const editBtn = document.createElement('button');
    editBtn.className = 'edit-btn';
    editBtn.type = 'button';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => startEditRoutine(rule.id));

    const delBtn = document.createElement('button');
    delBtn.className = 'delete-btn';
    delBtn.type = 'button';
    delBtn.textContent = '\u00d7';
    delBtn.setAttribute('aria-label', `Delete routine "${rule.text}"`);
    delBtn.addEventListener('click', () => deleteRecurringWithUndo(rule.id));

    actions.appendChild(editBtn);
    actions.appendChild(delBtn);
    top.appendChild(nameSpan);
    top.appendChild(actions);

    const badge = document.createElement('span');
    badge.className = 'badge cycle';
    badge.textContent = formatGroups(rule.groups);

    li.appendChild(top);
    li.appendChild(badge);
    list.appendChild(li);
  });
}

/* =========================================================================
   MODALS
   ========================================================================= */
function openModal(id) {
  if (id === 'settings-modal') {
    resetRoutineForm();
    renderRecurringSettings();
  }
  document.getElementById(id).classList.add('active');
}

function closeModal(id) {
  document.getElementById(id).classList.remove('active');
}

/* =========================================================================
   BACKUP EXPORT / IMPORT
   ========================================================================= */
function exportBackup() {
  const payload = { exportedAt: new Date().toISOString(), tasks, recurring, stats };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `tasks-backup-${getLocalISODate(new Date())}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function importBackup(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!Array.isArray(data.tasks) || !Array.isArray(data.recurring)) throw new Error('bad shape');
      tasks = data.tasks;
      recurring = data.recurring;
      stats = Object.assign({ totalCompleted: 0, totalAdded: 0, currentStreak: 0, lastActiveDate: null }, data.stats || {});
      saveState();
      renderRecurringSettings();
      renderAll();
      showToast('Backup imported.');
    } catch (err) {
      showToast("That file doesn't look like a valid backup.");
    }
  };
  reader.readAsText(file);
}

/* =========================================================================
   INIT
   ========================================================================= */
function init() {
  const todayStr = getLocalISODate(new Date());
  document.getElementById('view-date').value = todayStr;
  document.getElementById('add-task-date').value = todayStr;

  initTheme();
  updateAddTypeHint();
  setupTaskListDelegation(document.getElementById('task-list'));
  setupTaskListDelegation(document.getElementById('anytime-list'));
  renderWeekBuilder();
  renderRecurringSettings();
  renderAll();

  // View navigation
  document.getElementById('view-date').addEventListener('change', onViewDateChange);
  document.getElementById('prev-day').addEventListener('click', () => shiftViewDate(-1));
  document.getElementById('next-day').addEventListener('click', () => shiftViewDate(1));
  document.getElementById('today-btn').addEventListener('click', () => {
    document.getElementById('view-date').value = getLocalISODate(new Date());
    onViewDateChange();
  });

  // Search
  document.getElementById('search-toggle').addEventListener('click', () => {
    const row = document.getElementById('search-row');
    row.hidden = !row.hidden;
    if (!row.hidden) {
      document.getElementById('search-input').focus();
    } else {
      document.getElementById('search-input').value = '';
      searchQuery = '';
      renderAll();
    }
  });
  document.getElementById('search-input').addEventListener('input', e => {
    searchQuery = e.target.value.trim().toLowerCase();
    renderAll();
  });

  // Add task panel
  document.getElementById('add-task-btn').addEventListener('click', addTask);
  document.getElementById('new-task-text').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); addTask(); }
  });
  document.getElementById('new-task-type').addEventListener('change', () => {
    const type = document.getElementById('new-task-type').value;
    document.getElementById('add-task-date').disabled = (type === 'permanent');
    if (type === 'date') syncAddDateDefault();
    updateAddTypeHint();
  });

  // Anytime completed toggle
  document.getElementById('anytime-completed-toggle').addEventListener('click', () => {
    anytimeExpanded = !anytimeExpanded;
    renderAnytimeList();
  });

  // Week builder drag/resize
  document.getElementById('week-track').addEventListener('pointerdown', onWeekPointerDown);

  // Routine form
  document.getElementById('save-routine-btn').addEventListener('click', saveRoutine);
  document.getElementById('cancel-edit-btn').addEventListener('click', resetRoutineForm);

  // Backup
  document.getElementById('export-btn').addEventListener('click', exportBackup);
  document.getElementById('import-btn').addEventListener('click', () => document.getElementById('import-file').click());
  document.getElementById('import-file').addEventListener('change', e => {
    const file = e.target.files[0];
    if (file) importBackup(file);
    e.target.value = '';
  });

  // Modals
  document.querySelectorAll('[data-open-modal]').forEach(btn => {
    btn.addEventListener('click', () => openModal(btn.dataset.openModal));
  });
  document.querySelectorAll('[data-close-modal]').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target === el) closeModal(el.dataset.closeModal);
    });
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-overlay.active').forEach(m => closeModal(m.id));
    }
  });
}

init();
