import re

path = r'C:\Users\ggabl\Desktop\squadron-task-tracker\public\index.html'
content = open(path, 'r', encoding='utf-8').read()

new_script = r"""<script>
/* ── State ─────────────────────────────────────── */
let currentMember = null;
let currentTasks  = [];
let shopMembers   = [];

/* ── Boot ──────────────────────────────────────── */
async function init() {
  try {
    const res = await fetch('/api/auth/me');
    if (res.ok) { currentMember = await res.json(); showApp(); }
    else showLogin();
  } catch { showLogin(); }
}

function showLogin() {
  document.getElementById('login-overlay').style.display = 'flex';
  document.getElementById('app').style.display = 'none';
}

function showApp() {
  document.getElementById('login-overlay').style.display = 'none';
  document.getElementById('app').style.display = '';
  applyRole();
  populateUserUI();
  loadTasks();
  loadShopEvents();
  if (['supervisor','leadership'].includes(currentMember.role)) loadShopMembers();
}

function populateUserUI() {
  const m = currentMember;
  const initials = m.first_name[0] + m.last_name[0];
  const name     = m.last_name + ', ' + m.first_name[0] + '.';
  document.getElementById('sb-av').textContent   = initials;
  document.getElementById('sb-name').textContent = name;
  document.getElementById('sb-role').textContent = m.rank + ' · ' + m.shop;
  document.getElementById('mob-sub').textContent  = m.rank + ' ' + m.last_name + ' · ' + m.shop;
  document.getElementById('uta-label').textContent = 'May 2026 UTA · JB MDL';
  document.getElementById('shop-members-title').textContent = m.shop + ' Shop';
  document.getElementById('mob-title').textContent  = 'May 2026 UTA';
  document.getElementById('desk-title').textContent = 'May 2026 UTA';
  document.getElementById('desk-sub').textContent   = m.rank + ' ' + m.last_name + ' · ' + m.shop;
}

function applyRole() {
  const role = currentMember?.role;
  if (role === 'member') {
    document.querySelectorAll('[data-view="supervisor"]').forEach(el => el.style.display = 'none');
    document.querySelectorAll('[data-view="leadership"]').forEach(el => el.style.display = 'none');
  } else if (role === 'supervisor') {
    document.querySelectorAll('[data-view="leadership"]').forEach(el => el.style.display = 'none');
  }
  const sec = document.getElementById('shop-members-section');
  if (sec) sec.style.display = ['supervisor','leadership'].includes(role) ? '' : 'none';
}

/* ── Login ──────────────────────────────────────── */
async function doLogin() {
  const slug = document.getElementById('login-slug').value.trim().toLowerCase();
  const pwd  = document.getElementById('login-pwd').value;
  const btn  = document.getElementById('login-btn');
  const err  = document.getElementById('login-error');
  err.style.display = 'none';
  btn.disabled = true; btn.textContent = 'Signing in…';
  try {
    const res  = await fetch('/api/auth/login', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ slug, password: pwd }),
    });
    const data = await res.json();
    if (res.ok) { currentMember = data; showApp(); }
    else { err.textContent = data.error || 'Login failed'; err.style.display = ''; }
  } catch { err.textContent = 'Connection error — try again'; err.style.display = ''; }
  btn.disabled = false; btn.textContent = 'Sign In';
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('login-pwd').addEventListener('keydown',  e => { if (e.key==='Enter') doLogin(); });
  document.getElementById('login-slug').addEventListener('keydown', e => { if (e.key==='Enter') document.getElementById('login-pwd').focus(); });
  init();
});

/* ── Gauge ──────────────────────────────────────── */
function gauge(id, pct) {
  const svg = document.getElementById(id);
  if (!svg) return;
  const cx=80,cy=90,ir=55,or=69,n=52;
  const filled = Math.round(n*pct/100);
  svg.innerHTML = Array.from({length:n},(_,i)=>{
    const rad=(180+180*i/(n-1))*Math.PI/180, c=Math.cos(rad), s=Math.sin(rad);
    return `<line x1="${(cx+ir*c).toFixed(2)}" y1="${(cy+ir*s).toFixed(2)}" x2="${(cx+or*c).toFixed(2)}" y2="${(cy+or*s).toFixed(2)}" stroke="${i<filled?'var(--gon)':'var(--goff)'}" stroke-width="${i<filled?'2.6':'2'}" stroke-linecap="round"/>`;
  }).join('');
}

/* ── Bar chart ──────────────────────────────────── */
function barChart(elId, items) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.innerHTML = items.map(d => {
    const cls = d.hatch ? 'bar-rect hatch' : 'bar-rect';
    const h   = Math.max(0, Math.min(100, d.pct));
    return `<div class="bar-col"><div class="bar-track"><div class="${cls}" style="height:${h}%"></div></div><div class="bar-info"><div class="bar-val">${d.pct}%</div><div class="bar-x">${d.label}</div></div></div>`;
  }).join('');
}

/* ── My Tasks ───────────────────────────────────── */
async function loadTasks() {
  const res = await fetch('/api/tasks');
  if (!res.ok) return;
  currentTasks = await res.json();
  buildTasks();
  updateMemberStats();
}

function buildTasks() {
  const groups = {}, order = [];
  for (const t of currentTasks) {
    if (!groups[t.category_code]) { groups[t.category_code] = {label:t.category_label,tasks:[]}; order.push(t.category_code); }
    groups[t.category_code].tasks.push(t);
  }
  let html = '';
  for (const code of order) {
    if (code === 'upcoming') continue;
    const checkable = groups[code].tasks.filter(t => !t.is_upcoming);
    if (!checkable.length) continue;
    html += `<div class="task-group"><div class="grp-lbl">${groups[code].label}</div>`;
    for (const t of checkable) html += taskHTML(t);
    html += '</div>';
  }
  const upcoming = currentTasks.filter(t => t.is_upcoming);
  if (upcoming.length) {
    html += '<div class="task-group"><div class="grp-lbl">Upcoming</div>';
    for (const t of upcoming) html += upcomingHTML(t);
    html += '</div>';
  }
  document.getElementById('member-tasks').innerHTML = html;
}

function badgeFor(urgency, state) {
  if (state === 'done')       return {cls:'b-done',    text:'Done'};
  if (state === 'partial')    return {cls:'b-partial',  text:'In Progress'};
  if (urgency === 'overdue')  return {cls:'b-urgent',   text:'Overdue'};
  if (urgency === 'this_uta') return {cls:'b-urgent',   text:'This UTA'};
  if (urgency === 'next_uta') return {cls:'b-upcoming', text:'Next UTA'};
  return {cls:'b-upcoming', text:'Upcoming'};
}

const NOTE_ICO = `<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="1" y="1" width="10" height="10" rx="2"/><path d="M3.5 4h5M3.5 6.5h5M3.5 9h3"/></svg>`;

function taskHTML(t) {
  const b    = badgeFor(t.urgency, t.state);
  const orig = badgeFor(t.urgency, 'none');
  const apptParts = [t.appt_day, t.appt_time, t.appt_location].filter(Boolean);
  let det = apptParts.length ? apptParts.join(' · ') + (t.details ? ' · ' + t.details : '') : (t.details || '');
  return `<div class="task-item" id="ti-${t.id}" data-id="${t.id}" data-state="${t.state}" data-ou="${t.urgency}" data-ob="${orig.text}" onclick="cycleTask(this,event)">
    <div class="chk">
      <svg class="ic ic-part" viewBox="0 0 10 10" width="10" height="10" fill="none"><path d="M2.5 5h5" stroke="var(--warn)" stroke-width="1.8" stroke-linecap="round"/></svg>
      <svg class="ic ic-done" viewBox="0 0 10 10" width="10" height="10" fill="none"><path d="M1.5 5 4 7.5 8.5 2.5" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </div>
    <div class="task-body">
      <div class="task-title">${t.title}</div>
      ${det ? `<div class="task-det">${det}</div>` : ''}
      <button class="note-btn" onclick="toggleNote(event,'ti-${t.id}')">${NOTE_ICO}${t.note ? 'View note' : 'Add note'}</button>
      <div class="note-area" id="note-ti-${t.id}">
        <textarea class="note-input" rows="2" placeholder="Add a note for your supervisor…" onclick="event.stopPropagation()">${t.note || ''}</textarea>
        <button class="note-save-btn" onclick="saveNote(event,${t.id},'ti-${t.id}')">Save</button>
      </div>
    </div>
    <div class="badge ${b.cls}" id="badge-ti-${t.id}">${b.text}</div>
  </div>`;
}

function upcomingHTML(t) {
  return `<div class="task-item" style="opacity:.65;cursor:default">
    <div class="chk" style="opacity:.3"><svg viewBox="0 0 10 10" width="10" height="10" fill="none"><circle cx="5" cy="5" r="4" stroke="currentColor" stroke-width="1.5"/></svg></div>
    <div class="task-body">
      <div class="task-title">${t.title}</div>
      ${t.details ? `<div class="task-det">${t.details}</div>` : ''}
    </div>
    <div class="badge b-upcoming">Info</div>
  </div>`;
}

function getMemberCatBars() {
  const cats = {};
  for (const t of currentTasks) {
    if (t.is_upcoming) continue;
    if (!cats[t.category_code]) cats[t.category_code] = {label:t.category_code.slice(0,3).toUpperCase(),done:0,tot:0};
    cats[t.category_code].tot++;
    if (t.state==='done') cats[t.category_code].done++;
  }
  return Object.values(cats).map(c => {
    const pct = c.tot ? Math.round(c.done/c.tot*100) : 100;
    return {label:c.label, pct, hatch:pct<100&&pct>0};
  });
}

function updateMemberStats() {
  const checkable = currentTasks.filter(t => !t.is_upcoming);
  const done  = checkable.filter(t => t.state==='done').length;
  const total = checkable.length;
  const pct   = total ? Math.round(done/total*100) : 0;
  document.getElementById('gp-member').textContent         = pct + '%';
  document.getElementById('gs-done').textContent           = done;
  document.getElementById('gs-left').textContent           = total - done;
  document.getElementById('member-chart-meta').textContent = done + ' / ' + total;
  gauge('g-member', pct);
  barChart('member-bar-chart', getMemberCatBars());
}

async function cycleTask(el, event) {
  if (el.style.cursor==='default') return;
  if (event.target.closest('.note-btn,.note-area')) return;
  const states = ['none','partial','done'];
  const next   = states[(states.indexOf(el.dataset.state)+1)%3];
  el.dataset.state = next;
  const task = currentTasks.find(t => t.id===parseInt(el.dataset.id));
  if (task) task.state = next;
  const b = badgeFor(el.dataset.ou, next);
  const badge = document.getElementById('badge-'+el.id);
  badge.className = 'badge '+b.cls; badge.textContent = b.text;
  updateMemberStats();
  try {
    const note = el.querySelector('textarea')?.value || null;
    await fetch('/api/tasks/'+el.dataset.id, {
      method:'PUT', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({state:next, note}),
    });
  } catch(e) { console.error('save failed',e); }
}

function toggleNote(event, id) {
  event.stopPropagation();
  const area = document.getElementById('note-'+id);
  const open = area.classList.toggle('open');
  const btn  = event.currentTarget;
  btn.innerHTML = NOTE_ICO + (open ? 'Hide note' : 'Add note');
  if (open) setTimeout(() => area.querySelector('textarea').focus(), 50);
}

async function saveNote(event, taskId, elId) {
  event.stopPropagation();
  const note = document.querySelector('#note-'+elId+' textarea').value;
  const el   = document.getElementById(elId);
  const task = currentTasks.find(t => t.id===taskId);
  if (task) task.note = note;
  const noteBtn = el?.querySelector('.note-btn');
  if (noteBtn) noteBtn.innerHTML = NOTE_ICO + (note ? 'View note' : 'Add note');
  try {
    await fetch('/api/tasks/'+taskId, {
      method:'PUT', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({state: el?.dataset.state||'none', note}),
    });
  } catch(e) { console.error('note save failed',e); }
}

/* ── Shop events ────────────────────────────────── */
async function loadShopEvents() {
  const res = await fetch('/api/shop/events');
  if (!res.ok) return;
  buildShopEvents(await res.json());
}

function buildShopEvents(events) {
  const el = document.getElementById('shop-events-list');
  if (!el) return;
  const byDay = {};
  for (const e of events) { if (!byDay[e.day]) byDay[e.day]=[]; byDay[e.day].push(e); }
  const dayOrder = ['Friday','Friday/Saturday','Saturday','Sunday'];
  let html = '';
  for (const day of dayOrder) {
    if (!byDay[day]) continue;
    html += `<div class="task-group"><div class="grp-lbl">${day}</div>`;
    for (const e of byDay[day]) {
      const isWO  = e.event_type==='work_order';
      const isEmp = e.event_type==='emphasis';
      const time  = e.start_time ? e.start_time+(e.end_time?'–'+e.end_time:'') : '';
      const det   = [time, e.details].filter(Boolean).join(' · ');
      const bcls  = isWO ? 'b-upcoming' : isEmp ? 'b-urgent' : 'b-upcoming';
      const blbl  = isWO ? 'WO' : isEmp ? 'Emphasis' : day.split('/')[0].slice(0,3);
      html += `<div class="task-item" style="cursor:default">
        <div class="chk" style="opacity:.3"><svg viewBox="0 0 10 10" width="10" height="10" fill="none"><circle cx="5" cy="5" r="4" stroke="currentColor" stroke-width="1.5"/></svg></div>
        <div class="task-body">
          <div class="task-title">${isWO ? e.wo_number+' — ' : ''}${e.title}</div>
          ${det ? `<div class="task-det">${det}</div>` : ''}
        </div>
        <div class="badge ${bcls}">${blbl}</div>
      </div>`;
    }
    html += '</div>';
  }
  el.innerHTML = html || '<p style="color:var(--t2);padding:12px 4px">No shop events for this UTA.</p>';
}

/* ── Shop members ───────────────────────────────── */
async function loadShopMembers() {
  const res = await fetch('/api/shop/members');
  if (!res.ok) return;
  shopMembers = await res.json();
  buildMembers();
}

function buildMembers() {
  const el = document.getElementById('member-list');
  if (!el) return;
  el.innerHTML = shopMembers.map(m => {
    const done  = parseInt(m.done_tasks)||0;
    const total = parseInt(m.total_tasks)||0;
    const pct   = total ? Math.round(done/total*100) : 0;
    const dc    = pct===100?'dot-ok':pct>=50?'dot-warn':'dot-bad';
    const init  = m.first_name[0]+m.last_name[0];
    return `<div class="mem-item" id="memitem-${m.id}">
      <div class="mem-row" onclick="toggleMem(${m.id})">
        <div class="avatar">${init}</div>
        <div class="mem-meta"><div class="mem-name">${m.last_name}, ${m.first_name[0]}.</div><div class="mem-rank">${m.rank}</div></div>
        <div><div class="mem-frac">${done}/${total}</div><div class="mem-frac-sub">${pct}%</div></div>
        <div class="dot ${dc}"></div>
        <svg class="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
      </div>
      <div class="expand-panel" id="expand-${m.id}">
        <div class="mem-expand-inner" id="expand-inner-${m.id}">
          <p style="color:var(--t2);font-size:13px">Loading…</p>
        </div>
      </div>
    </div>`;
  }).join('');
  barChart('shop-bar-chart', shopMembers.map(m => {
    const done=parseInt(m.done_tasks)||0, tot=parseInt(m.total_tasks)||0;
    const pct=tot?Math.round(done/tot*100):0;
    return {label:m.last_name.slice(0,5), pct, hatch:pct<100&&pct>0};
  }));
  updateShopStats();
}

function updateShopStats() {
  const total  = shopMembers.reduce((a,m)=>a+(parseInt(m.total_tasks)||0),0);
  const done   = shopMembers.reduce((a,m)=>a+(parseInt(m.done_tasks)||0),0);
  const pct    = total ? Math.round(done/total*100) : 0;
  const behind = shopMembers.filter(m=>{
    const t=parseInt(m.total_tasks)||0,d=parseInt(m.done_tasks)||0;
    return t>0 && Math.round(d/t*100)<50;
  }).length;
  gauge('g-sup', pct);
  const gpEl = document.querySelector('#view-supervisor .gauge-pct');
  if (gpEl) gpEl.textContent = pct+'%';
  const stats = document.querySelectorAll('#view-supervisor .stat-num');
  if (stats[0]) stats[0].textContent = shopMembers.length - behind;
  if (stats[1]) stats[1].textContent = behind;
  const meta = document.querySelector('#view-supervisor .chart-meta');
  if (meta) meta.textContent = shopMembers.length+' members';
}

async function toggleMem(memberId) {
  const item  = document.getElementById('memitem-'+memberId);
  const panel = document.getElementById('expand-'+memberId);
  const inner = document.getElementById('expand-inner-'+memberId);
  const isOpen = item.classList.toggle('expanded');
  panel.classList.toggle('open', isOpen);
  item.querySelector('.chevron').style.transform = isOpen ? 'rotate(90deg)' : '';
  if (!isOpen || !inner.querySelector('p')) return;
  try {
    const res   = await fetch('/api/shop/members/'+memberId+'/tasks');
    if (!res.ok) throw new Error();
    const tasks = await res.json();
    if (!tasks.length) { inner.innerHTML='<p style="color:var(--t2);font-size:13px">No tasks this UTA.</p>'; return; }
    const cats = {};
    for (const t of tasks) {
      if (t.is_upcoming) continue;
      if (!cats[t.category_code]) cats[t.category_code]={label:t.category_label,tasks:[]};
      cats[t.category_code].tasks.push(t);
    }
    let html = '';
    for (const [,cat] of Object.entries(cats)) {
      const d = cat.tasks.filter(t=>t.state==='done').length;
      html += `<div style="margin-bottom:14px"><div style="font-size:11px;font-weight:600;color:var(--t2);letter-spacing:.06em;text-transform:uppercase;margin-bottom:6px">${cat.label} · ${d}/${cat.tasks.length}</div>`;
      for (const t of cat.tasks) {
        const sc=t.state==='done'?'var(--ok)':t.state==='partial'?'var(--warn)':'var(--t3)';
        const si=t.state==='done'?'✓':t.state==='partial'?'–':'○';
        html += `<div style="display:flex;gap:8px;align-items:flex-start;padding:6px 0;border-bottom:1px solid var(--border)">
          <span style="color:${sc};font-size:13px;flex-shrink:0;margin-top:1px">${si}</span>
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:500">${t.title}</div>
            ${t.details ? `<div style="font-size:12px;color:var(--t2)">${t.details}</div>` : ''}
            ${t.note    ? `<div style="font-size:12px;color:var(--t2);font-style:italic">Note: ${t.note}</div>` : ''}
          </div>
          <button onclick="supToggle(event,${t.id},${memberId},'${t.state}')" style="font-size:11px;padding:3px 8px;border:1px solid var(--border);border-radius:6px;background:none;cursor:pointer;color:var(--t2);white-space:nowrap;flex-shrink:0">
            ${t.state==='done'?'Undo':'Mark Done'}
          </button>
        </div>`;
      }
      html += '</div>';
    }
    inner.innerHTML = html;
  } catch { inner.innerHTML='<p style="color:var(--urgent);font-size:13px">Failed to load.</p>'; }
}

async function supToggle(event, taskId, memberId, currentState) {
  event.stopPropagation();
  const newState = currentState==='done' ? 'none' : 'done';
  await fetch('/api/tasks/'+taskId, {
    method:'PUT', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({state:newState}),
  });
  const inner = document.getElementById('expand-inner-'+memberId);
  inner.innerHTML = '<p style="color:var(--t2);font-size:13px">Loading…</p>';
  const item = document.getElementById('memitem-'+memberId);
  item.classList.remove('expanded');
  document.getElementById('expand-'+memberId).classList.remove('open');
  await toggleMem(memberId);
  await loadShopMembers();
}

/* ── View switch ────────────────────────────────── */
function switchView(btn) {
  const name = btn.dataset.view;
  document.querySelectorAll('.sb-item,.mob-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll(`[data-view="${name}"]`).forEach(b => b.classList.add('active'));
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-'+name).classList.add('active');
  const m = currentMember;
  const titles = {
    member:     ['May 2026 UTA',       m ? m.rank+' '+m.last_name+' · '+m.shop : ''],
    supervisor: [(m?.shop||'')+' Shop', 'Supervisor View'],
    leadership: ['108th CES',           'Leadership View'],
  };
  const [t, s] = titles[name] || ['',''];
  document.getElementById('mob-title').textContent  = t;
  document.getElementById('mob-sub').textContent    = s;
  document.getElementById('desk-title').textContent = t;
  document.getElementById('desk-sub').textContent   = s;
}
</script>"""

# Find and replace the script block
script_start = content.index('<script>')
script_end   = content.index('</script>', script_start) + len('</script>')
new_content  = content[:script_start] + new_script + content[script_end:]
open(path, 'w', encoding='utf-8').write(new_content)
print('Done. File length:', len(new_content), 'chars')
