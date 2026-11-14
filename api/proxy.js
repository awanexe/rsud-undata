/**
 * Rumah Sakit Undata — Vercel Serverless API Proxy
 *
 * Required Vercel Environment Variable:
 *   GAS_WEB_APP_URL=https://script.google.com/macros/s/AKfycbw_I4eMPrPFla4jyDX4v7c-1umMw2WX1ALvVDBroKfj2HhOftNy41j0oJZXaNgdKTHTGg/exec
 *
 * Node.js runtime with global fetch (Node.js 18+).
 */

const MAX_BODY_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 25000;

const ALLOWED_ACTIONS = new Set([
  'getPublicQueue',
  'login',
  'logout',
  'validateSession',
  'getDashboard',
  'getQueues',
  'getPoli',
  'searchQueue',
  'callNext',
  'callQueue',
  'skipQueue',
  'completeQueue',
  'getServiceHistory',
  'createPoli',
  'updatePoliDurations'
]);

function sendJson(res, statusCode, payload) {
  return res.status(statusCode).json(payload);
}

function statusForBackendCode(code) {
  const map = {
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    BAD_ACTION: 400,
    INVALID_JSON: 400,
    VALIDATION_ERROR: 400,
    PAYLOAD_TOO_LARGE: 413,
    NOT_FOUND: 404,
    DUPLICATE: 409,
    INVALID_QUEUE: 409,
    QUEUE_ACTIVE: 409,
    QUEUE_EMPTY: 409,
    DB_NOT_READY: 503,
    DATABASE_ERROR: 503,
    CONFIG_ERROR: 500,
    SERVER_ERROR: 500
  };
  return map[code] || 400;
}

function isValidGasWebAppUrl(value) {
  if (typeof value !== 'string' || value.length > 500) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' &&
      parsed.hostname === 'script.google.com' &&
      /^\/macros\/s\/[A-Za-z0-9_-]+\/exec\/?$/.test(parsed.pathname) &&
      !parsed.search &&
      !parsed.hash;
  } catch (_) {
    return false;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, {
      success: false,
      code: 'METHOD_NOT_ALLOWED',
      message: 'Endpoint hanya menerima metode POST.',
      data: null
    });
  }

  const gasUrl = process.env.GAS_WEB_APP_URL;
  if (!isValidGasWebAppUrl(gasUrl)) {
    return sendJson(res, 500, {
      success: false,
      code: 'CONFIG_ERROR',
      message: 'GAS_WEB_APP_URL belum dikonfigurasi dengan URL Google Apps Script Web App yang valid.',
      data: null
    });
  }

  try {
    let body = req.body;

    if (typeof body === 'string') {
      if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
        return sendJson(res, 413, {
          success: false,
          code: 'PAYLOAD_TOO_LARGE',
          message: 'Ukuran request terlalu besar.',
          data: null
        });
      }
      try {
        body = JSON.parse(body);
      } catch (_) {
        return sendJson(res, 400, {
          success: false,
          code: 'INVALID_JSON',
          message: 'Format JSON request tidak valid.',
          data: null
        });
      }
    } else if (body && Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_BODY_BYTES) {
      return sendJson(res, 413, {
        success: false,
        code: 'PAYLOAD_TOO_LARGE',
        message: 'Ukuran request terlalu besar.',
        data: null
      });
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return sendJson(res, 400, {
        success: false,
        code: 'VALIDATION_ERROR',
        message: 'Body request harus berupa objek JSON.',
        data: null
      });
    }

    if (typeof body.action !== 'string' || !ALLOWED_ACTIONS.has(body.action)) {
      return sendJson(res, 400, {
        success: false,
        code: 'BAD_ACTION',
        message: 'Action tidak dikenal atau tidak diizinkan.',
        data: null
      });
    }

    const payload = body.payload === undefined ? {} : body.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return sendJson(res, 400, {
        success: false,
        code: 'VALIDATION_ERROR',
        message: 'Payload harus berupa objek.',
        data: null
      });
    }

    const token = body.token === undefined ? '' : body.token;
    if (typeof token !== 'string' || token.length > 300) {
      return sendJson(res, 400, {
        success: false,
        code: 'VALIDATION_ERROR',
        message: 'Token sesi tidak valid.',
        data: null
      });
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let upstreamResponse;
    try {
      upstreamResponse = await fetch(gasUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          action: body.action,
          payload: payload,
          token: token
        }),
        redirect: 'follow',
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeoutHandle);
    }

    const responseText = await upstreamResponse.text();
    let backendResult;

    try {
      backendResult = JSON.parse(responseText);
    } catch (_) {
      return sendJson(res, 502, {
        success: false,
        code: 'UPSTREAM_INVALID_RESPONSE',
        message: 'Google Apps Script tidak mengembalikan JSON. Periksa deployment dan izin akses Web App.',
        data: null
      });
    }

    if (!backendResult || typeof backendResult !== 'object' || typeof backendResult.success !== 'boolean') {
      return sendJson(res, 502, {
        success: false,
        code: 'UPSTREAM_INVALID_RESPONSE',
        message: 'Format respons backend tidak sesuai kontrak API.',
        data: null
      });
    }

    if (!upstreamResponse.ok) {
      return sendJson(res, 502, {
        success: false,
        code: 'UPSTREAM_ERROR',
        message: 'Backend Google Apps Script gagal memproses request.',
        data: null
      });
    }

    // GAS ContentService may return HTTP 200 for application-level errors.
    // Map its structured error code so frontend can handle expired sessions.
    const statusCode = backendResult.success
      ? 200
      : statusForBackendCode(backendResult.code);

    return sendJson(res, statusCode, backendResult);
  } catch (error) {
    const timedOut = error && error.name === 'AbortError';
    return sendJson(res, timedOut ? 504 : 502, {
      success: false,
      code: timedOut ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNAVAILABLE',
      message: timedOut
        ? 'Google Apps Script melewati batas waktu respons.'
        : 'Tidak dapat menghubungi backend Google Apps Script.',
      data: null
    });
  }
};
