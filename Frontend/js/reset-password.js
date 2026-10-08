document.addEventListener('DOMContentLoaded', () => {
  if (window.SpenIcons) {
    document.querySelectorAll('[data-icon]').forEach((el) => {
      el.innerHTML = SpenIcons.icon(el.getAttribute('data-icon'));
    });
  }

  const form = document.getElementById('resetPasswordForm');
  const newPasswordInput = document.getElementById('newPassword');
  const confirmPasswordInput = document.getElementById('confirmPassword');
  const passwordError = document.getElementById('passwordError');
  const toastContainer = document.getElementById('toastContainer');
  const resetSubtitle = document.getElementById('resetSubtitle');
  const submitBtn = document.getElementById('resetSubmitBtn');

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
    const iconMarkup = window.SpenIcons 
      ? SpenIcons.icon(type === 'success' ? 'CircleCheck' : 'AlertTriangle') 
      : '';
    toast.innerHTML = `${iconMarkup}<span>${escapeHtml(message)}</span>`;
    toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('hide');
      setTimeout(() => toast.remove(), 320);
    }, 3200);
  }

  function getTokenFromUrl() {
    const params = new URLSearchParams(window.location.search);
    return params.get('token') || '';
  }

  const token = getTokenFromUrl();
  if (!token) {
    if (resetSubtitle) {
      resetSubtitle.textContent = 'Invalid or missing reset token. Please request a new password reset link.';
      resetSubtitle.style.color = '#fca5a5';
    }
    if (submitBtn) submitBtn.disabled = true;
  }

  if (newPasswordInput && confirmPasswordInput) {
    const check = () => {
      if (passwordError) passwordError.style.display = 'none';
      if (confirmPasswordInput.value === '') return;
      if (newPasswordInput.value !== confirmPasswordInput.value) {
        if (passwordError) passwordError.style.display = 'block';
      }
    };
    newPasswordInput.addEventListener('input', check);
    confirmPasswordInput.addEventListener('input', check);
  }

  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!token) {
      showToast('Reset token is missing.');
      return;
    }
    const newPassword = newPasswordInput ? newPasswordInput.value : '';
    const confirmPassword = confirmPasswordInput ? confirmPasswordInput.value : '';
    if (newPassword.length < 8) {
      showToast('New password must be at least 8 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      if (passwordError) passwordError.style.display = 'block';
      showToast('Passwords do not match.');
      return;
    }
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Resetting...';
    }
    try {
      const res = await apiRequest('/auth/reset-password', 'POST', { token, newPassword }, false);
      showToast(res.message || 'Password has been reset successfully.', 'success');
      setTimeout(() => {
        window.location.href = 'login.html';
      }, 1200);
    } catch (err) {
      showToast(err.message || 'Failed to reset password.');
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Reset Password';
      }
    }
  });
});