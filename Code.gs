/**
 * RUMAH SAKIT UNDATA — Queue Management API
 * Runtime: Google Apps Script V8
 *
 * Required Script Property:
 *   SPREADSHEET_ID = ID Google Spreadsheet database
 *
 * Run setupDatabase() once, then createInitialAdmin(name). Profiles are selected without passwords.
 */

const APP = Object.freeze({
  SESSION_TTL_SECONDS: 21600,
  SHEETS: {
    Queues: [
      'queue_id', 'queue_number', 'poli_id', 'patient_code', 'status',
      'created_at', 'called_at', 'completed_at', 'updated_at'
    ],
    Poli: [
      'poli_id', 'poli_name', 'room', 'avg_service_minutes', 'status', 'created_at'
    ],
    Staff: [
      'staff_id', 'name', 'username', 'password_hash', 'access_type', 'status', 'created_at'
    ],
    ServiceHistory: [
      'history_id', 'queue_id', 'queue_number', 'poli_id',
      'staff_id', 'staff_name', 'action', 'timestamp'
    ],
    Settings: ['setting_key', 'setting_value']
  },
  ALLOWED_ACCESS: ['ADMIN', 'STAFF'],
  ALLOWED_QUEUE_STATUSES: ['WAITING', 'CALLED', 'SERVING', 'SKIPPED', 'COMPLETED'],
});

/* ============================== API ENTRY ============================== */

function doGet(e) {
  const action = e && e.parameter ? String(e.parameter.action || '') : '';
  if (action === 'health') {
    return jsonResponse({
      success: true,
      message: 'Rumah Sakit Undata Queue API siap.',
      data: { service: 'undata-queue-api', runtime: 'GAS V8' }
    });
  }
  return jsonResponse({
    success: false,
    code: 'METHOD_NOT_ALLOWED',
    message: 'Gunakan metode POST melalui API proxy.',
    data: null
  });
}

function doPost(e) {
  try {
    const raw = e && e.postData && e.postData.contents ? e.postData.contents : '{}';
    if (raw.length > 60000) {
      throw apiError_('Ukuran request terlalu besar.', 'PAYLOAD_TOO_LARGE');
    }

    let request;
    try {
      request = JSON.parse(raw);
    } catch (parseError) {
      throw apiError_('Format JSON request tidak valid.', 'INVALID_JSON');
    }

    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      throw apiError_('Request harus berupa objek JSON.', 'VALIDATION_ERROR');
    }

    const action = String(request.action || '');
    if (!/^[A-Za-z][A-Za-z0-9]{1,49}$/.test(action)) {
      throw apiError_('Action tidak valid.', 'BAD_ACTION');
    }

    const payload = request.payload && typeof request.payload === 'object' && !Array.isArray(request.payload)
      ? request.payload : {};
    const data = routeAction_(action, payload, String(request.token || ''));

    return jsonResponse({
      success: true,
      message: 'Request berhasil.',
      data: data
    });
  } catch (error) {
    const code = error && error.code ? error.code : 'SERVER_ERROR';
    const message = error && error.message ? error.message : 'Terjadi kesalahan pada server.';
    console.error('[Undata API] ' + code + ': ' + message);
    return jsonResponse({
      success: false,
      code: code,
      message: message,
      data: null
    });
  }
}

function jsonResponse(value) {
  return ContentService
    .createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}

function routeAction_(action, payload, token) {
  // Endpoint publik hanya mengembalikan nomor antrean dan informasi poli.
  if (action === 'getPublicQueue') return getPublicQueue_();
  if (action === 'getLoginProfiles') return getLoginProfiles_();
  if (action === 'login') return login_(payload);

  if (action === 'logout') {
    const session = requireSession_(token, APP.ALLOWED_ACCESS);
    CacheService.getScriptCache().remove('session_' + token);
    return { logged_out: true, staff_id: session.staff_id };
  }

  const user = requireSession_(token, APP.ALLOWED_ACCESS);

  switch (action) {
    case 'validateSession':
      return { user: user };

    case 'getDashboard':
      return getDashboard_();

    case 'getQueues':
      return { queues: listQueues_() };

    case 'getPoli':
      return { poli: listPoli_() };

    case 'searchQueue':
      return searchQueue_(payload.query);

    case 'callNext':
      return callNext_(payload.poli_id || '', user);

    case 'callQueue':
      return callQueue_(payload.queue_id, user);

    case 'skipQueue':
      return skipQueue_(payload.queue_id, user);

    case 'completeQueue':
      return completeQueue_(payload.queue_id, user);

    case 'getServiceHistory':
      return getServiceHistory_(payload.date);

    case 'createPoli':
      requireAdmin_(user);
      return createPoli_(payload);

    case 'updatePoliDurations':
      requireAdmin_(user);
      return updatePoliDurations_(payload.items);

    default:
      throw apiError_('Action tidak dikenal.', 'BAD_ACTION');
  }
}

/* ============================== DATABASE ============================== */

function getSpreadsheet_() {
  const spreadsheetId = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!spreadsheetId) {
    throw apiError_('Script Property SPREADSHEET_ID belum diatur.', 'CONFIG_ERROR');
  }
  try {
    return SpreadsheetApp.openById(spreadsheetId);
  } catch (error) {
    throw apiError_('Spreadsheet tidak dapat dibuka. Periksa SPREADSHEET_ID dan izin akses.', 'DATABASE_ERROR');
  }
}

function getSheet_(sheetName) {
  const target = getSpreadsheet_().getSheetByName(sheetName);
  if (!target) {
    throw apiError_('Sheet ' + sheetName + ' belum tersedia. Jalankan setupDatabase().', 'DB_NOT_READY');
  }
  return target;
}

function readRows_(sheetName) {
  const target = getSheet_(sheetName);
  const values = target.getDataRange().getValues();
  if (values.length < 2) return [];

  const headers = values[0].map(String);
  return values.slice(1)
    .filter(row => row.some(value => value !== '' && value !== null))
    .map(row => {
      const record = {};
      headers.forEach((header, index) => {
        record[header] = serializeValue_(row[index]);
      });
      return record;
    });
}

function serializeValue_(value) {
  return value instanceof Date ? value.toISOString() : value;
}

function safeSheetValue_(value) {
  if (typeof value === 'string' && /^[=+\-@]/.test(value)) return "'" + value;
  return value === undefined || value === null ? '' : value;
}

function appendRecord_(sheetName, record) {
  const target = getSheet_(sheetName);
  const headers = APP.SHEETS[sheetName];
  const row = headers.map(header => safeSheetValue_(record[header]));
  target.appendRow(row);
}

function updateRecordById_(sheetName, idField, idValue, changes) {
  const target = getSheet_(sheetName);
  const values = target.getDataRange().getValues();
  if (!values.length) return false;

  const headers = values[0].map(String);
  const idColumn = headers.indexOf(idField);
  if (idColumn < 0) throw apiError_('Kolom identitas tidak ditemukan.', 'DATABASE_ERROR');

  for (let rowIndex = 1; rowIndex < values.length; rowIndex++) {
    if (String(values[rowIndex][idColumn]) !== String(idValue)) continue;

    Object.keys(changes).forEach(key => {
      const column = headers.indexOf(key);
      if (column >= 0) {
        target.getRange(rowIndex + 1, column + 1).setValue(safeSheetValue_(changes[key]));
      }
    });
    return true;
  }
  return false;
}

function findRecord_(sheetName, field, value) {
  return readRows_(sheetName).find(record => String(record[field]) === String(value)) || null;
}

function makeId_(prefix) {
  return prefix + '_' + Utilities.getUuid().replace(/-/g, '').slice(0, 18);
}

function nowIso_() {
  return new Date().toISOString();
}

function todayKey_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function setupDatabase() {
  const ss = getSpreadsheet_();

  Object.keys(APP.SHEETS).forEach(sheetName => {
    let target = ss.getSheetByName(sheetName);
    if (!target) target = ss.insertSheet(sheetName);

    const expectedHeaders = APP.SHEETS[sheetName];
    const lastColumn = target.getLastColumn();

    if (target.getLastRow() === 0 || lastColumn === 0) {
      target.getRange(1, 1, 1, expectedHeaders.length).setValues([expectedHeaders]);
    } else {
      const existingHeaders = target
        .getRange(1, 1, 1, Math.max(lastColumn, expectedHeaders.length))
        .getValues()[0]
        .map(String);

      const mismatch = expectedHeaders.findIndex((header, index) => existingHeaders[index] !== header);
      if (mismatch >= 0) {
        throw new Error(
          'Header Sheet ' + sheetName + ' tidak sesuai pada kolom ' + (mismatch + 1) +
          '. Database tidak diubah. Periksa struktur header secara manual.'
        );
      }
    }
    target.setFrozenRows(1);
  });

  seedDefaultPoli_();
  return 'Database Rumah Sakit Undata berhasil disiapkan. Data lama tidak dihapus.';
}

function seedDefaultPoli_() {
  if (readRows_('Poli').length > 0) return;

  const defaults = [
    ['Poli Umum', 'Ruang 01', 15],
    ['Poli Anak', 'Ruang 02', 20],
    ['Poli Gigi', 'Ruang 03', 25],
    ['Poli Penyakit Dalam', 'Ruang 04', 20],
    ['Poli Kebidanan', 'Ruang 05', 25]
  ];

  defaults.forEach(item => {
    appendRecord_('Poli', {
      poli_id: makeId_('POLI'),
      poli_name: item[0],
      room: item[1],
      avg_service_minutes: item[2],
      status: 'OPEN',
      created_at: nowIso_()
    });
  });
}

/* ============================== AUTHENTICATION ============================== */

/**
 * Jalankan sekali dari editor Apps Script untuk membuat administrator pertama.
 * Metode akses dashboard menggunakan pemilihan profil tanpa password.
 */
function createInitialAdmin(name) {
  if (readRows_('Staff').some(staff => staff.access_type === 'ADMIN' && staff.status === 'ACTIVE')) {
    throw new Error('Administrator aktif sudah tersedia.');
  }

  appendRecord_('Staff', createStaffRecord_(name || 'Administrator RS Undata', 'ADMIN'));
  return 'Profil administrator berhasil dibuat.';
}

/**
 * Jalankan manual dari Apps Script untuk menambah profil petugas.
 * accessType hanya ADMIN atau STAFF.
 */
function createStaffAccount(name, accessType) {
  const role = String(accessType || 'STAFF').toUpperCase();
  if (APP.ALLOWED_ACCESS.indexOf(role) < 0) {
    throw new Error('accessType hanya boleh ADMIN atau STAFF.');
  }

  const cleanName = String(name || '').trim().slice(0, 100);
  if (!cleanName) throw new Error('Nama profil wajib diisi.');
  const duplicate = readRows_('Staff').some(staff =>
    String(staff.name).trim().toLowerCase() === cleanName.toLowerCase() &&
    staff.status === 'ACTIVE'
  );
  if (duplicate) throw new Error('Nama profil aktif sudah digunakan.');

  appendRecord_('Staff', createStaffRecord_(cleanName, role));
  return 'Profil ' + role + ' berhasil dibuat.';
}

function createStaffRecord_(name, accessType) {
  return {
    staff_id: makeId_('STAFF'),
    name: String(name || 'Pengguna').trim().slice(0, 100),
    // Kolom username dan password_hash dipertahankan agar kompatibel
    // dengan header Spreadsheet lama, tetapi tidak digunakan untuk login.
    username: '',
    password_hash: '',
    access_type: accessType,
    status: 'ACTIVE',
    created_at: nowIso_()
  };
}

function getLoginProfiles_() {
  const profiles = readRows_('Staff')
    .filter(staff => staff.status === 'ACTIVE' && APP.ALLOWED_ACCESS.indexOf(staff.access_type) >= 0)
    .map(staff => ({
      staff_id: staff.staff_id,
      name: staff.name,
      access_type: staff.access_type
    }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'id'));

  return { profiles: profiles };
}

function login_(payload) {
  const staffId = requiredText_(payload.staff_id, 100, 'Profil pengguna');
  const staff = findRecord_('Staff', 'staff_id', staffId);

  if (!staff || staff.status !== 'ACTIVE' || APP.ALLOWED_ACCESS.indexOf(staff.access_type) < 0) {
    throw apiError_('Profil tidak ditemukan atau sudah tidak aktif.', 'UNAUTHORIZED');
  }

  const token = Utilities.getUuid() + Utilities.getUuid() + Utilities.getUuid();
  const user = {
    staff_id: staff.staff_id,
    name: staff.name,
    access_type: staff.access_type
  };

  CacheService.getScriptCache().put(
    'session_' + token,
    JSON.stringify(user),
    APP.SESSION_TTL_SECONDS
  );

  return {
    token: token,
    user: user,
    expires_in: APP.SESSION_TTL_SECONDS
  };
}

function requireSession_(token, allowedAccess) {
  if (!token) throw apiError_('Sesi tidak ditemukan. Silakan masuk kembali.', 'UNAUTHORIZED');

  const cached = CacheService.getScriptCache().get('session_' + token);
  if (!cached) throw apiError_('Sesi berakhir. Silakan masuk kembali.', 'UNAUTHORIZED');

  const user = JSON.parse(cached);
  if (allowedAccess.indexOf(user.access_type) < 0) {
    throw apiError_('Akses tidak diizinkan.', 'FORBIDDEN');
  }
  return user;
}

function requireAdmin_(user) {
  if (!user || user.access_type !== 'ADMIN') {
    throw apiError_('Fitur ini hanya dapat digunakan administrator.', 'FORBIDDEN');
  }
}

/* ============================== QUEUE & POLI ============================== */

function listPoli_() {
  return readRows_('Poli').sort((a, b) =>
    String(a.poli_name).localeCompare(String(b.poli_name), 'id')
  );
}

function listQueues_() {
  const today = todayKey_();
  const queues = readRows_('Queues')
    .filter(queue => String(queue.created_at).slice(0, 10) === today)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));

  const poliById = {};
  listPoli_().forEach(poli => { poliById[poli.poli_id] = poli; });

  queues.forEach(queue => {
    if (queue.status === 'WAITING' || queue.status === 'SKIPPED') {
      const samePoli = queues.filter(item => item.poli_id === queue.poli_id);
      const ahead = samePoli.filter(item =>
        (item.status === 'WAITING' || item.status === 'SKIPPED') &&
        String(item.created_at) < String(queue.created_at)
      ).length;
      const activeCount = samePoli.some(item =>
        item.status === 'SERVING' || item.status === 'CALLED'
      ) ? 1 : 0;
      const average = Number(poliById[queue.poli_id] && poliById[queue.poli_id].avg_service_minutes) || 15;
      queue.estimated_wait_minutes = (ahead + activeCount) * average;
    } else {
      queue.estimated_wait_minutes = 0;
    }
  });

  return queues;
}

function getQueueStats_(queues) {
  return {
    waiting: queues.filter(queue => queue.status === 'WAITING' || queue.status === 'SKIPPED').length,
    serving: queues.filter(queue => queue.status === 'SERVING' || queue.status === 'CALLED').length,
    completed: queues.filter(queue => queue.status === 'COMPLETED').length,
    total: queues.length
  };
}

function getDashboard_() {
  const queues = listQueues_();
  const activeQueues = queues.filter(queue => queue.status === 'SERVING' || queue.status === 'CALLED');
  activeQueues.sort((a, b) => String(b.called_at || '').localeCompare(String(a.called_at || '')));
  const nextQueues = queues
    .filter(queue => queue.status === 'WAITING')
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    .slice(0, 5);

  return {
    stats: getQueueStats_(queues),
    queues: queues.slice().reverse().slice(0, 40),
    current: activeQueues[0] || null,
    next: nextQueues
  };
}

function getPublicQueue_() {
  const queues = listQueues_();
  const activeQueues = queues.filter(queue => queue.status === 'SERVING' || queue.status === 'CALLED');
  activeQueues.sort((a, b) => String(b.called_at || '').localeCompare(String(a.called_at || '')));
  const nextQueues = queues
    .filter(queue => queue.status === 'WAITING')
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    .slice(0, 6);

  // Data publik sengaja tidak menyertakan nama, kode pasien, atau informasi identitas pasien.
  return {
    current: activeQueues[0] ? {
      queue_number: activeQueues[0].queue_number,
      poli_id: activeQueues[0].poli_id,
      called_at: activeQueues[0].called_at
    } : null,
    next: nextQueues.map(queue => ({
      queue_number: queue.queue_number,
      poli_id: queue.poli_id
    })),
    poli: listPoli_().map(poli => ({
      poli_id: poli.poli_id,
      poli_name: poli.poli_name,
      room: poli.room,
      status: poli.status
    })),
    updated_at: nowIso_()
  };
}

function searchQueue_(query) {
  const term = String(query || '').trim().toLowerCase();
  if (!term) return { queues: [] };

  return {
    queues: listQueues_().filter(queue =>
      String(queue.queue_number).toLowerCase().indexOf(term) >= 0 ||
      String(queue.patient_code).toLowerCase().indexOf(term) >= 0
    )
  };
}

function getActiveQueueForPoli_(queues, poliId) {
  return queues.find(queue =>
    queue.poli_id === poliId && (queue.status === 'SERVING' || queue.status === 'CALLED')
  ) || null;
}

function callNext_(poliId, user) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const queues = listQueues_();
    const normalizedPoliId = String(poliId || '');

    const eligible = queues
      .filter(queue =>
        (queue.status === 'WAITING' || queue.status === 'SKIPPED') &&
        (!normalizedPoliId || queue.poli_id === normalizedPoliId) &&
        !getActiveQueueForPoli_(queues, queue.poli_id)
      )
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));

    const next = eligible[0];
    if (!next) throw apiError_('Tidak ada antrean yang dapat dipanggil.', 'QUEUE_EMPTY');

    const timestamp = nowIso_();
    updateRecordById_('Queues', 'queue_id', next.queue_id, {
      status: 'SERVING',
      called_at: timestamp,
      updated_at: timestamp
    });
    appendHistory_(next, user, 'CALL');

    return {
      queue_id: next.queue_id,
      queue_number: next.queue_number,
      poli_id: next.poli_id
    };
  } finally {
    lock.releaseLock();
  }
}

function callQueue_(queueId, user) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const id = requiredText_(queueId, 100, 'queue_id');
    const queue = findRecord_('Queues', 'queue_id', id);
    if (!queue) throw apiError_('Antrean tidak ditemukan.', 'NOT_FOUND');
    if (queue.status !== 'WAITING' && queue.status !== 'SKIPPED') {
      throw apiError_('Hanya antrean menunggu atau dilewati yang dapat dipanggil.', 'INVALID_QUEUE');
    }

    const queues = listQueues_();
    if (getActiveQueueForPoli_(queues, queue.poli_id)) {
      throw apiError_('Masih ada antrean aktif pada poli ini.', 'QUEUE_ACTIVE');
    }

    const timestamp = nowIso_();
    updateRecordById_('Queues', 'queue_id', queue.queue_id, {
      status: 'SERVING',
      called_at: timestamp,
      updated_at: timestamp
    });
    appendHistory_(queue, user, 'CALL');

    return { queue_id: queue.queue_id, queue_number: queue.queue_number, poli_id: queue.poli_id };
  } finally {
    lock.releaseLock();
  }
}

function skipQueue_(queueId, user) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const id = requiredText_(queueId, 100, 'queue_id');
    const queue = findRecord_('Queues', 'queue_id', id);
    if (!queue) throw apiError_('Antrean tidak ditemukan.', 'NOT_FOUND');
    if (queue.status === 'COMPLETED') {
      throw apiError_('Antrean yang sudah selesai tidak dapat dilewati.', 'INVALID_QUEUE');
    }

    const timestamp = nowIso_();
    updateRecordById_('Queues', 'queue_id', queue.queue_id, {
      status: 'SKIPPED',
      updated_at: timestamp
    });
    appendHistory_(queue, user, 'SKIP');

    return { queue_id: queue.queue_id, status: 'SKIPPED' };
  } finally {
    lock.releaseLock();
  }
}

function completeQueue_(queueId, user) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const id = requiredText_(queueId, 100, 'queue_id');
    const queue = findRecord_('Queues', 'queue_id', id);
    if (!queue) throw apiError_('Antrean tidak ditemukan.', 'NOT_FOUND');
    if (queue.status !== 'SERVING' && queue.status !== 'CALLED') {
      throw apiError_('Hanya antrean yang sedang dilayani yang dapat diselesaikan.', 'INVALID_QUEUE');
    }

    const timestamp = nowIso_();
    updateRecordById_('Queues', 'queue_id', queue.queue_id, {
      status: 'COMPLETED',
      completed_at: timestamp,
      updated_at: timestamp
    });
    appendHistory_(queue, user, 'COMPLETE');

    return { queue_id: queue.queue_id, status: 'COMPLETED' };
  } finally {
    lock.releaseLock();
  }
}

function appendHistory_(queue, user, action) {
  appendRecord_('ServiceHistory', {
    history_id: makeId_('HIST'),
    queue_id: queue.queue_id,
    queue_number: queue.queue_number,
    poli_id: queue.poli_id,
    staff_id: user.staff_id,
    staff_name: user.name,
    action: action,
    timestamp: nowIso_()
  });
}

function getServiceHistory_(date) {
  const selectedDate = date ? String(date) : todayKey_();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(selectedDate)) {
    throw apiError_('Format tanggal harus YYYY-MM-DD.', 'VALIDATION_ERROR');
  }

  const history = readRows_('ServiceHistory')
    .filter(item => String(item.timestamp).slice(0, 10) === selectedDate)
    .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
    .slice(0, 300);

  return { history: history };
}

/* ============================== POLI MANAGEMENT ============================== */

function createPoli_(payload) {
  const name = requiredText_(payload.poli_name, 60, 'Nama poli');
  const room = requiredText_(payload.room, 40, 'Ruang pelayanan');
  const duration = Number(payload.avg_service_minutes);

  if (!Number.isInteger(duration) || duration < 1 || duration > 240) {
    throw apiError_('Durasi pelayanan harus berupa bilangan bulat 1–240 menit.', 'VALIDATION_ERROR');
  }

  const duplicate = listPoli_().some(poli => poli.poli_name.toLowerCase() === name.toLowerCase());
  if (duplicate) throw apiError_('Nama poli sudah terdaftar.', 'DUPLICATE');

  const poli = {
    poli_id: makeId_('POLI'),
    poli_name: name,
    room: room,
    avg_service_minutes: duration,
    status: 'OPEN',
    created_at: nowIso_()
  };
  appendRecord_('Poli', poli);
  return poli;
}

function updatePoliDurations_(items) {
  if (!Array.isArray(items) || items.length > 100) {
    throw apiError_('Daftar pengaturan poli tidak valid.', 'VALIDATION_ERROR');
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    items.forEach(item => {
      const duration = Number(item.avg_service_minutes);
      if (!Number.isInteger(duration) || duration < 1 || duration > 240) {
        throw apiError_('Durasi setiap poli harus 1–240 menit.', 'VALIDATION_ERROR');
      }
      if (!updateRecordById_('Poli', 'poli_id', item.poli_id, {
        avg_service_minutes: duration
      })) {
        throw apiError_('Poli tidak ditemukan.', 'NOT_FOUND');
      }
    });
    return { updated: items.length };
  } finally {
    lock.releaseLock();
  }
}

/* ============================== VALIDATION & ERRORS ============================== */

function requiredText_(value, maxLength, label) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  if (!text || text.length > maxLength) {
    throw apiError_((label || 'Input') + ' wajib diisi dan maksimal ' + maxLength + ' karakter.', 'VALIDATION_ERROR');
  }
  return text;
}

function apiError_(message, code) {
  const error = new Error(message);
  error.code = code || 'SERVER_ERROR';
  return error;
}
