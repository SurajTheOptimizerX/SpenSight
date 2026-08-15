// SpenSight API client.
// Loaded as a classic <script> BEFORE the page controller so its globals are
// available everywhere. backend/server.js serves Frontend/ statically and mounts
// /api/* on the same origin, so requests default to relative '/api'.
// For a static-hosted frontend, override before this script loads:
//   <script>window.SPENSIGHT_API_BASE = 'https://example.com/api';</script>

const API_BASE_URL = window.SPENSIGHT_API_BASE || '/api';

// ---------- Token / session helpers ----------
function getToken() {
  return localStorage.getItem('spensight_token');
}

function getStoredUser() {
  try {
    return JSON.parse(localStorage.getItem('spensight_user') || 'null');
  } catch (error) {
    return null;
  }
}

// ---------- Core request helper ----------
async function apiRequest(endpoint, method = 'GET', data = null, requiresAuth = true) {
  const headers = { 'Content-Type': 'application/json' };

  if (requiresAuth) {
    const token = getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
  }

  const config = { method, headers };
  if (data && ['POST', 'PUT', 'PATCH'].includes(method)) {
    config.body = JSON.stringify(data);
  }

  try {
    const response = await fetch(`${API_BASE_URL}${endpoint}`, config);

    if (response.status === 401 && requiresAuth) {
      localStorage.removeItem('spensight_token');
      localStorage.removeItem('spensight_user');
      window.location.href = 'login.html';
      return;
    }

    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(result.error || result.message || 'An error occurred during the API call.');
    }

    return result;
  } catch (error) {
    console.error(`[API Error] ${method} ${endpoint}:`, error);
    throw error;
  }
}

// ---------- Multipart upload (CSV) helper ----------
// fileFieldName matches the multer field name in the route (e.g. 'statement').
async function apiUpload(endpoint, file, fileFieldName = 'file', extraFields = {}) {
  const form = new FormData();
  form.append(fileFieldName, file);
  Object.entries(extraFields || {}).forEach(([key, value]) => {
    form.append(key, String(value));
  });

  const token = getToken();
  const response = await fetch(`${API_BASE_URL}${endpoint}`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });

  const result = await response.json().catch(() => ({}));

  if (response.status === 401) {
    localStorage.removeItem('spensight_token');
    localStorage.removeItem('spensight_user');
    window.location.href = 'login.html';
    return;
  }

  if (!response.ok) {
    throw new Error(result.error || result.message || 'Upload failed.');
  }

  return result;
}

// ---------- Grouped endpoint helpers (thin wrappers) ----------
const authAPI = {
  login: (credentials) => apiRequest('/auth/login', 'POST', credentials, false),
  register: (userData) => apiRequest('/auth/register', 'POST', userData, false),
};

const dataAPI = {
  getSummary: (params = '') => apiRequest(`/analytics/summary${params}`, 'GET'),
  getTransactions: (params = '') => apiRequest(`/transactions${params}`, 'GET'),
  addTransaction: (transaction) => apiRequest('/transactions', 'POST', transaction),
  deleteTransaction: (id) => apiRequest(`/transactions/${id}`, 'DELETE'),
};

// Explicitly expose globals so classic AND module scripts can use them.
window.getToken = getToken;
window.getStoredUser = getStoredUser;
window.apiRequest = apiRequest;
window.apiUpload = apiUpload;
window.authAPI = authAPI;
window.dataAPI = dataAPI;
