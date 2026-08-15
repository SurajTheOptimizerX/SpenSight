document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('[data-icon]').forEach((el) => {
    el.innerHTML = SpenIcons.icon(el.getAttribute('data-icon'));
  });

  const registerForm = document.getElementById('registerForm');
  const regSubmitBtn = document.getElementById('regSubmitBtn');
  const toastContainer = document.getElementById('toastContainer');

  function escapeHtml(str) {
    return String(str === undefined || str === null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function showToast(message, type = 'error') {
    if (!toastContainer) return;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `${SpenIcons.icon(type === 'success' ? 'CircleCheck' : 'AlertTriangle')}<span>${escapeHtml(message)}</span>`;
    toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('hide');
      setTimeout(() => toast.remove(), 320);
    }, 3200);
  }

  function setLoading(loading) {
    regSubmitBtn.disabled = loading;
    regSubmitBtn.innerHTML = loading
      ? '<span data-icon="RefreshCw" style="width:16px;height:16px;animation:spin 1s linear infinite;"></span> Creating Account...'
      : 'Create Account';
    if (loading) {
      regSubmitBtn.querySelectorAll('[data-icon]').forEach((el) => {
        el.innerHTML = SpenIcons.icon(el.getAttribute('data-icon'));
      });
    }
  }

  if (!registerForm) return;

  registerForm.addEventListener('submit', async (event) => {
    event.preventDefault();

    const name = document.getElementById('regName').value.trim();
    const email = document.getElementById('regEmail').value.trim();
    const password = document.getElementById('regPassword').value.trim();

    if (!name || !email || !password) {
      showToast('Please fill in all fields.');
      return;
    }

    if (password.length < 6) {
      showToast('Password must be at least 6 characters long.');
      return;
    }

    setLoading(true);

    try {
      const data = await apiRequest('/auth/register', 'POST', { name, email, password }, false);

      if (data && data.requiresVerification) {
        const registerFormEl = document.getElementById('registerForm');
        const successEl = document.getElementById('registerSuccess');
        if (registerFormEl) registerFormEl.style.display = 'none';
        if (successEl) successEl.style.display = 'block';
        return;
      }

      localStorage.setItem('spensight_token', data.token);
      localStorage.setItem('spensight_user', JSON.stringify(data.user));

      showToast('Account created successfully!', 'success');
      setTimeout(() => {
        window.location.href = 'dashboard.html';
      }, 600);
    } catch (error) {
      showToast(error.message || 'Registration failed. Please try again.');
    } finally {
      setLoading(false);
    }
  });
});
