/* Rumah Sakit Undata — frontend application */
'use strict';

const CONFIG = { pollMs: 5000, statsPollMs: 15000 };
const state = {
  token: sessionStorage.getItem('undata_token') || '',
  user: JSON.parse(sessionStorage.getItem('undata_user') || 'null'),
  queues: [], poli: [], stats: {}, current: null, next: [], history: [],
  currentView: 'overview', publicMode: false, lastPublicNumber: '', pollHandle: null
};
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const dateTime = value => value ? new Date(value).toLocaleString('id-ID',{hour:'2-digit',minute:'2-digit',day:'2-digit',month:'short'}) : '—';
const clockTime = value => value ? new Date(value).toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit'}) : '—';
const statusText = status => ({WAITING:'Menunggu',CALLED:'Dipanggil',SERVING:'Dilayani',SKIPPED:'Dilewati',COMPLETED:'Selesai'})[status] || status || '—';
const poliName = id => state.poli.find(p => p.poli_id === id)?.poli_name || '—';

async function api(action, payload = {}, auth = true) {
  const headers = {'Content-Type':'application/json'};
  const body = {action, payload};
  if (auth && state.token) body.token = state.token;
  const response = await fetch('/api/proxy', {method:'POST', headers, body:JSON.stringify(body)});
  let result;
  try { result = await response.json(); } catch { throw new Error('Respons server tidak valid. Periksa konfigurasi API.'); }
  if (!response.ok || !result.success) {
    if (response.status === 401 || result.code === 'UNAUTHORIZED') logout(false);
    throw new Error(result.message || `Permintaan gagal (${response.status})`);
  }
  return result.data;
}
function toast(message, type='success') {
  const el = document.createElement('div'); el.className = `toast ${type === 'error' ? 'error' : ''}`; el.textContent = message;
  $('#toast-region').append(el); setTimeout(() => el.remove(), 3500);
}
function setConnection(ok, message='Terhubung') {
  const label = $('#connection-label'); if (label) label.textContent = ok ? message : 'Koneksi bermasalah';
}
function refreshIcons(){ if (window.lucide) window.lucide.createIcons(); }
function setView(view) {
  state.currentView = view;
  $('#staff-content').hidden = view !== 'overview';
  $$('.view-page').forEach(el => el.hidden = el.id !== `${view}-view`);
  $$('.nav-item[data-view]').forEach(el => el.classList.toggle('active', el.dataset.view === view));
  $('#page-title').textContent = ({overview:'Overview',queue:'Manajemen Antrean',poli:'Poli & Layanan',history:'Riwayat Pelayanan',settings:'Pengaturan'})[view] || 'Overview';
  $('#sidebar').classList.remove('open');
  if (view === 'history') loadHistory();
  if (view === 'settings') renderSettings();
}
function setLoggedIn(user) {
  state.user = user; sessionStorage.setItem('undata_user', JSON.stringify(user));
  $('#login-overlay').hidden = true; $('#logout-button').hidden = false;
  $('#user-chip').innerHTML = `<span class="avatar">${esc((user.name || 'U').slice(0,1).toUpperCase())}</span><span><b>${esc(user.name)}</b><small>${esc(user.access_type)}</small></span>`;
  $$('[data-admin-only]').forEach(el => el.hidden = user.access_type !== 'ADMIN');
  if (user.access_type === 'STAFF') $('#settings-view').hidden = true;
}
function logout(showMessage=true) {
  state.token = ''; state.user = null; sessionStorage.removeItem('undata_token'); sessionStorage.removeItem('undata_user');
  if (state.pollHandle) clearInterval(state.pollHandle);
  $('#login-overlay').hidden = false; $('#logout-button').hidden = true;
  $('#user-chip').innerHTML = '<span class="avatar">U</span><span><b>Mode publik</b><small>Monitoring</small></span>';
  if ($('#profile-select')) loadLoginProfiles();
  if (showMessage) toast('Anda telah keluar.');
}
async function loadLoginProfiles() {
  const select = $('#profile-select');
  const button = $('#profile-login-button');
  select.disabled = true;
  button.disabled = true;
  select.innerHTML = '<option value="">Memuat daftar profil...</option>';
  try {
    const data = await api('getLoginProfiles', {}, false);
    const profiles = data.profiles || [];
    select.innerHTML = '<option value="">Pilih profil pengguna</option>' +
      profiles.map(profile => `<option value="${esc(profile.staff_id)}">${esc(profile.name)} — ${profile.access_type === 'ADMIN' ? 'Administrator' : 'Petugas'}</option>`).join('');
    select.disabled = profiles.length === 0;
    button.disabled = profiles.length === 0;
    if (!profiles.length) {
      select.innerHTML = '<option value="">Belum ada profil aktif</option>';
      $('#login-error').textContent = 'Belum ada profil aktif. Hubungi administrator untuk menyiapkan profil.';
    } else {
      $('#login-error').textContent = '';
    }
  } catch (error) {
    select.innerHTML = '<option value="">Gagal memuat profil</option>';
    $('#login-error').textContent = error.message;
  }
}
async function login(staffId) {
  const data = await api('login',{staff_id:staffId},false);
  state.token = data.token; sessionStorage.setItem('undata_token',data.token);
  setLoggedIn(data.user); await loadAll(); startPolling(); setView('overview');
}
async function loadAll() {
  const [dashboard, poliData] = await Promise.all([api('getDashboard'),api('getPoli')]);
  state.stats = dashboard.stats || {}; state.queues = dashboard.queues || [];
  state.current = dashboard.current || null; state.next = dashboard.next || [];
  state.poli = poliData.poli || [];
  renderDashboard(); renderQueue(); renderPoli(); populatePoliFilters(); setConnection(true);
}
function renderDashboard() {
  $('#stat-waiting').textContent = state.stats.waiting ?? 0;
  $('#stat-serving').textContent = state.stats.serving ?? 0;
  $('#stat-completed').textContent = state.stats.completed ?? 0;
  $('#stat-total').textContent = state.stats.total ?? 0;
  const current = state.current;
  $('#now-number').textContent = current?.queue_number || '—';
  $('#now-poli').textContent = current ? poliName(current.poli_id) : 'Belum ada pelayanan aktif';
  $('#now-patient').textContent = current?.patient_code ? `Kode pasien ${current.patient_code}` : 'Belum ada antrean aktif';
  const poli = state.poli.find(p => p.poli_id === current?.poli_id);
  $('#now-room').textContent = poli?.room || '—'; $('#now-called').textContent = clockTime(current?.called_at);
  $('#next-number').textContent = state.next[0]?.queue_number || '—';
  $('#overview-queue-body').innerHTML = state.queues.slice(0,8).map(q => `<tr><td><b class="queue-number">${esc(q.queue_number)}</b></td><td>${esc(q.patient_code || '—')}</td><td>${esc(poliName(q.poli_id))}</td><td>${esc(clockTime(q.created_at))}</td><td><span class="status-tag status-${esc(q.status)}">${esc(statusText(q.status))}</span></td></tr>`).join('') || '<tr><td colspan="5" class="empty-cell">Belum ada data antrean.</td></tr>';
  $('#poli-status-list').innerHTML = state.poli.map(p => {
    const count = state.queues.filter(q => q.poli_id === p.poli_id && q.status === 'WAITING').length;
    return `<div class="poli-row"><div><b>${esc(p.poli_name)}</b><small>${esc(p.room || 'Ruang belum diatur')}</small></div><div class="poli-row-right"><b>${count}</b><small>menunggu · ${p.status === 'OPEN' ? 'Buka' : 'Tutup'}</small></div></div>`;
  }).join('') || '<p class="muted">Belum ada poli yang tersedia.</p>';
}
function renderQueue() {
  const query = ($('#queue-search')?.value || '').toLowerCase();
  const poliFilter = $('#queue-poli-filter')?.value || '';
  const statusFilter = $('#queue-status-filter')?.value || '';
  const rows = state.queues.filter(q => (!query || `${q.queue_number} ${q.patient_code}`.toLowerCase().includes(query)) && (!poliFilter || q.poli_id === poliFilter) && (!statusFilter || q.status === statusFilter));
  $('#queue-table-body').innerHTML = rows.map(q => `<tr><td><b class="queue-number">${esc(q.queue_number)}</b></td><td>${esc(q.patient_code || '—')}</td><td>${esc(poliName(q.poli_id))}</td><td>${esc(clockTime(q.created_at))}</td><td>${q.estimated_wait_minutes ?? '—'} menit</td><td><span class="status-tag status-${esc(q.status)}">${esc(statusText(q.status))}</span></td><td><div class="row-actions">${q.status === 'WAITING' || q.status === 'SKIPPED' ? `<button class="mini-button" data-action="call" data-id="${esc(q.queue_id)}">Panggil</button>` : ''}${q.status === 'SERVING' || q.status === 'CALLED' ? `<button class="mini-button" data-action="complete" data-id="${esc(q.queue_id)}">Selesai</button>` : ''}${q.status === 'WAITING' ? `<button class="mini-button" data-action="skip" data-id="${esc(q.queue_id)}">Lewati</button>` : ''}</div></td></tr>`).join('') || '<tr><td colspan="7" class="empty-cell">Tidak ada antrean yang sesuai.</td></tr>';
}
function renderPoli() {
  $('#poli-cards').innerHTML = state.poli.map(p => {
    const waiting = state.queues.filter(q => q.poli_id === p.poli_id && q.status === 'WAITING').length;
    const serving = state.queues.filter(q => q.poli_id === p.poli_id && q.status === 'SERVING').length;
    return `<article class="poli-card"><div class="panel-heading"><span class="status-tag ${p.status === 'OPEN' ? 'status-COMPLETED' : 'status-SKIPPED'}">${p.status === 'OPEN' ? '● Buka' : '● Tutup'}</span></div><h3>${esc(p.poli_name)}</h3><p>${esc(p.room || 'Ruang belum ditentukan')}</p><div class="poli-card-stats"><div><b>${waiting}</b><small>Menunggu</small></div><div><b>${serving}</b><small>Dilayani</small></div><div><b>${p.avg_service_minutes || 15} mnt</b><small>Rata-rata</small></div></div></article>`;
  }).join('') || '<p class="muted">Belum ada poli.</p>';
}
function populatePoliFilters() {
  const options = state.poli.map(p => `<option value="${esc(p.poli_id)}">${esc(p.poli_name)}</option>`).join('');
  $('#queue-poli-filter').innerHTML = '<option value="">Semua poli</option>' + options;
}
function renderSettings() {
  $('#settings-poli-list').innerHTML = state.poli.map(p => `<label class="setting-row"><span><b>${esc(p.poli_name)}</b><small class="muted">Durasi rata-rata pelayanan dalam menit</small></span><input type="number" min="1" max="240" value="${Number(p.avg_service_minutes) || 15}" data-setting-poli="${esc(p.poli_id)}"></label>`).join('');
}
async function loadHistory() {
  const date = $('#history-date').value || new Date().toISOString().slice(0,10);
  $('#history-date').value = date;
  try {
    const data = await api('getServiceHistory',{date});
    $('#history-body').innerHTML = (data.history || []).map(h => `<tr><td>${esc(dateTime(h.timestamp))}</td><td><b class="queue-number">${esc(h.queue_number || '—')}</b></td><td>${esc(poliName(h.poli_id))}</td><td>${esc(h.staff_name || '—')}</td><td>${esc(h.action)}</td></tr>`).join('') || '<tr><td colspan="5" class="empty-cell">Belum ada riwayat.</td></tr>';
  } catch(error) { toast(error.message,'error'); }
}
async function performQueueAction(action, queueId) {
  try { await api(action,{queue_id:queueId}); await loadAll(); toast('Status antrean berhasil diperbarui.'); }
  catch(error) { toast(error.message,'error'); }
}
async function callNext(poliId='') {
  try { const data = await api('callNext',{poli_id:poliId}); await loadAll(); toast(`Memanggil nomor ${data.queue_number || 'berikutnya'}.`); announce(data.queue_number,poliName(data.poli_id)); }
  catch(error) { toast(error.message,'error'); }
}
function announce(number,poli) {
  if (!number || !('speechSynthesis' in window)) return;
  try { window.speechSynthesis.cancel(); const utterance = new SpeechSynthesisUtterance(`Nomor antrean ${number}, silakan menuju ${poli}`); utterance.lang = 'id-ID'; utterance.rate = .9; window.speechSynthesis.speak(utterance); } catch {}
}
function startPolling() {
  if (state.pollHandle) clearInterval(state.pollHandle);
  state.pollHandle = setInterval(async () => {
    try { if (state.user && !state.publicMode) await loadAll(); else await loadPublic(); }
    catch(error) { setConnection(false); console.warn(error); }
  }, CONFIG.pollMs);
}
async function loadPublic() {
  const data = await api('getPublicQueue',{},false);
  const current = data.current || null;
  $('#public-current').textContent = current?.queue_number || '—';
  $('#public-current-poli').textContent = current ? poliNameFrom(data.poli,current.poli_id) : 'Belum ada pemanggilan';
  $('#public-current-room').textContent = current ? `Silakan menuju ${poliNameFrom(data.poli,current.poli_id)} · ${data.poli.find(p=>p.poli_id===current.poli_id)?.room || 'Ruang pelayanan'}` : 'Silakan perhatikan layar informasi';
  const next = data.next || [];
  $('#public-next-list').innerHTML = next.slice(0,6).map(q => `<div class="public-next-item">${esc(q.queue_number)}<small>${esc(poliNameFrom(data.poli,q.poli_id))}</small></div>`).join('') || '<span>Belum ada antrean berikutnya</span>';
  $('#public-poli-list').innerHTML = (data.poli || []).map(p => `<div class="public-poli-row"><b>${esc(p.poli_name)}</b><span>${p.status === 'OPEN' ? 'Layanan buka' : 'Tutup'}</span></div>`).join('') || '<span class="muted">Informasi poli belum tersedia.</span>';
  $('#public-updated').textContent = `Diperbarui ${new Date().toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit',second:'2-digit'})}`;
  if (current?.queue_number && current.queue_number !== state.lastPublicNumber) { state.lastPublicNumber = current.queue_number; $('#public-current').animate([{transform:'scale(.96)',opacity:.5},{transform:'scale(1)',opacity:1}],{duration:350}); }
  state.poli = data.poli || [];
}
function poliNameFrom(list,id){return list?.find(p=>p.poli_id===id)?.poli_name || 'Poli';}
function openPublic() {
  state.publicMode = true; $('#app-shell').hidden = true; $('#public-screen').hidden = false;
  loadPublic().catch(error => toast(error.message,'error')); startPolling();
}
function closePublic() {
  state.publicMode = false; $('#public-screen').hidden = true; $('#app-shell').hidden = false;
  if (state.user) loadAll().catch(error => toast(error.message,'error'));
}
function updateClock() {
  const now = new Date();
  $('#today-label').textContent = now.toLocaleDateString('id-ID',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
  $('#public-time').textContent = now.toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit'});
  $('#public-date').textContent = now.toLocaleDateString('id-ID',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
}
function bindEvents() {
  $('#login-form').addEventListener('submit',async e=>{e.preventDefault();const staffId=$('#profile-select').value;$('#login-error').textContent='';if(!staffId){$('#login-error').textContent='Silakan pilih profil terlebih dahulu.';return;}try{await login(staffId);}catch(error){$('#login-error').textContent=error.message;}});
  $('#profile-select').addEventListener('change',()=>{$('#profile-login-button').disabled=!$('#profile-select').value;});
  $('#continue-public').addEventListener('click',openPublic);
  $('#open-public').addEventListener('click',openPublic); $('#exit-public').addEventListener('click',closePublic);
  $('#logout-button').addEventListener('click',()=>logout());
  $('#menu-toggle').addEventListener('click',()=>$('#sidebar').classList.toggle('open'));
  $('#side-nav').addEventListener('click',e=>{const button=e.target.closest('[data-view]');if(button)setView(button.dataset.view);});
  $$('[data-go]').forEach(el=>el.addEventListener('click',()=>setView(el.dataset.go)));
  $('#refresh-button').addEventListener('click',()=>loadAll().then(()=>toast('Data diperbarui.')).catch(e=>toast(e.message,'error')));
  $('#call-next-top').addEventListener('click',()=>callNext()); $('#call-next-page').addEventListener('click',()=>callNext());
  $('#complete-current').addEventListener('click',()=>state.current && performQueueAction('completeQueue',state.current.queue_id));
  $('#skip-current').addEventListener('click',()=>state.current && performQueueAction('skipQueue',state.current.queue_id));
  $('#queue-search').addEventListener('input',renderQueue); $('#queue-poli-filter').addEventListener('change',renderQueue); $('#queue-status-filter').addEventListener('change',renderQueue);
  $('#queue-table-body').addEventListener('click',e=>{const btn=e.target.closest('[data-action]');if(btn)performQueueAction(({call:'callQueue',skip:'skipQueue',complete:'completeQueue'})[btn.dataset.action],btn.dataset.id);});
  $('#history-refresh').addEventListener('click',loadHistory);
  $('#save-settings').addEventListener('click',async()=>{const values=$$('[data-setting-poli]').map(input=>({poli_id:input.dataset.settingPoli,avg_service_minutes:Number(input.value)}));try{await api('updatePoliDurations',{items:values});await loadAll();toast('Pengaturan durasi disimpan.');}catch(e){toast(e.message,'error');}});
  $('#add-poli-button').addEventListener('click',()=>$('#poli-modal').showModal());
  $('#poli-form').addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.currentTarget);try{await api('createPoli',Object.fromEntries(f));$('#poli-modal').close();e.currentTarget.reset();await loadAll();toast('Poli berhasil ditambahkan.');}catch(error){toast(error.message,'error');}});
}
async function init() {
  bindEvents(); refreshIcons(); updateClock(); setInterval(updateClock,1000);
  $('#history-date').value = new Date().toISOString().slice(0,10);
  if (state.token && state.user) {
    try { const session = await api('validateSession'); setLoggedIn(session.user); await loadAll(); startPolling(); }
    catch { logout(false); }
  } else {
    $('#login-overlay').hidden = false;
    try { const data = await api('getPublicQueue',{},false); state.poli = data.poli || []; } catch {}
    await loadLoginProfiles();
  }
  refreshIcons();
}
document.addEventListener('DOMContentLoaded',init);
