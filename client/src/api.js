const KEY = 'af_token';

export const getToken = () => sessionStorage.getItem(KEY);
export const setToken = (t) => (t ? sessionStorage.setItem(KEY, t) : sessionStorage.removeItem(KEY));

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message || `Request failed (${status})`);
    this.status = status;
    this.code = body?.error?.code;
    this.fields = body?.error?.fields || {};
  }
}

export async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(`/api${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw new ApiError(0, { error: { message: 'Cannot reach the server. Check your connection.' } });
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/auth/login') {
    // Session expired or revoked: drop the token and let the app return to the login screen.
    setToken(null);
    window.dispatchEvent(new Event('af:unauthorized'));
  }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export const DEMO = [
  { role: 'cutting_supervisor', label: 'Cutting Supervisor', email: 'supervisor@apparelflow.demo', password: 'Cut#Super2026', blurb: 'Creates cutting orders and tracks progress' },
  { role: 'cutting_verifier', label: 'Cutting Verifier', email: 'verifier@apparelflow.demo', password: 'Verify#QC2026', blurb: 'Counts parts, approves or rejects batches' },
  { role: 'sewing_supervisor', label: 'Sewing Supervisor', email: 'sewing@apparelflow.demo', password: 'Sew#Floor2026', blurb: 'Receives verified batches on the floor' },
];

export const ROLE_LABEL = Object.fromEntries(DEMO.map((d) => [d.role, d.label]));

export function fmtTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts.replace(' ', 'T') + 'Z');
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

// Strict whole-number parsing for form inputs: digits only, no sign, no decimals.
export function parseWhole(text) {
  const t = String(text).trim();
  if (t === '') return { empty: true };
  if (!/^\d+$/.test(t)) return { error: 'Whole numbers only (no decimals, signs or letters)' };
  const n = Number(t);
  if (!Number.isSafeInteger(n)) return { error: 'Number is too large' };
  return { value: n };
}

export function parseYards(text) {
  const t = String(text).trim();
  if (t === '') return { empty: true };
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return { error: 'Enter yards as a positive number (max 2 decimals)' };
  const n = Number(t);
  if (n <= 0) return { error: 'Must be greater than 0' };
  return { value: n };
}
