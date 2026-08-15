// Base URL for the live production backend hosted on Render
const API_BASE_URL = 'https://spensight.onrender.com/api';

/**
 * Universal helper to perform API requests with JSON headers and token handling
 */
async function apiRequest(endpoint, method = 'GET', data = null, requiresAuth = true) {
    const headers = {
        'Content-Type': 'application/json'
    };

    if (requiresAuth) {
        const token = localStorage.getItem('token');
        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }
    }

    const config = {
        method,
        headers
    };

    if (data && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
        config.body = JSON.stringify(data);
    }

    try {
        const response = await fetch(`${API_BASE_URL}${endpoint}`, config);

        if (response.status === 401 && requiresAuth) {
            localStorage.removeItem('token');
            window.location.href = '/login.html';
            return;
        }

        const result = await response.json();

        if (!response.ok) {
            throw new Error(result.message || 'An error occurred during API call.');
        }

        return result;
    } catch (error) {
        console.error(`[API Error] ${method} ${endpoint}:`, error);
        throw error;
    }
}

// Authentication Endpoints
export const authAPI = {
    login: (credentials) => apiRequest('/auth/login', 'POST', credentials, false),
    register: (userData) => apiRequest('/auth/register', 'POST', userData, false),
    getProfile: () => apiRequest('/auth/me', 'GET')
};

// Data & Metrics Endpoints
export const dataAPI = {
    getDashboardMetrics: () => apiRequest('/dashboard/metrics', 'GET'),
    getTransactions: (params = '') => apiRequest(`/transactions${params}`, 'GET'),
    addTransaction: (transaction) => apiRequest('/transactions', 'POST', transaction),
    deleteTransaction: (id) => apiRequest(`/transactions/${id}`, 'DELETE')
};