document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('[data-icon]').forEach((el) => {
    el.innerHTML = SpenIcons.icon(el.getAttribute('data-icon'));
  });

  const loginForm = document.getElementById('loginForm');
  const submitBtn = document.getElementById('submitBtn');
  const toastContainer = document.getElementById('toastContainer');

  // ---------- Math CAPTCHA ----------
  const captchaQuestion = document.getElementById('captchaQuestion');
  const captchaRefresh = document.getElementById('captchaRefresh');
  const captchaAnswer = document.getElementById('captchaAnswer');
  const captchaError = document.getElementById('captchaError');
  let captchaResult = 0;

  function generateCaptcha() {
    const a = 10 + Math.floor(Math.random() * 90);
    const b = 10 + Math.floor(Math.random() * 90);
    const useAddition = Math.random() >= 0.5;
    if (useAddition) {
      captchaResult = a + b;
      captchaQuestion.textContent = `${a} + ${b} = ?`;
    } else {
      const high = Math.max(a, b);
      const low = Math.min(a, b);
      captchaResult = high - low;
      captchaQuestion.textContent = `${high} - ${low} = ?`;
    }
    if (captchaError) captchaError.style.display = 'none';
    if (captchaAnswer) captchaAnswer.value = '';
  }

  if (captchaRefresh) {
    captchaRefresh.addEventListener('click', generateCaptcha);
  }
  if (captchaQuestion) {
    generateCaptcha();
  }
  if (captchaAnswer) {
    captchaAnswer.addEventListener('input', () => {
      if (captchaError) captchaError.style.display = 'none';
    });
  }

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
    submitBtn.disabled = loading;
    submitBtn.innerHTML = loading
      ? '<span data-icon="RefreshCw" style="width:16px;height:16px;animation:spin 1s linear infinite;"></span> Authenticating...'
      : 'Login';
    if (loading) {
      submitBtn.querySelectorAll('[data-icon]').forEach((el) => {
        el.innerHTML = SpenIcons.icon(el.getAttribute('data-icon'));
      });
    }
  }

  if (!loginForm) return;

  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();

    const emailVal = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value.trim();

    if (!emailVal || !password) {
      showToast('Please fill in both email and password.');
      return;
    }

    const rawAnswer = String((captchaAnswer && captchaAnswer.value) || '').trim();
    if (rawAnswer === '' || parseInt(rawAnswer, 10) !== captchaResult) {
      if (captchaError) captchaError.style.display = 'block';
      generateCaptcha();
      if (captchaAnswer) captchaAnswer.focus();
      return;
    }

    setLoading(true);

    try {
      // Sends both email and username so the backend controller receives its expected key
      const data = await apiRequest(
        '/auth/login',
        'POST',
        { email: emailVal, username: emailVal, password },
        false
      );

      localStorage.setItem('spensight_token', data.token);
      localStorage.setItem('spensight_user', JSON.stringify(data.user));

      showToast('Login successful!', 'success');
      setTimeout(() => {
        window.location.href = 'dashboard.html';
      }, 500);
    } catch (error) {
      showToast(error.message || 'Login failed. Please check your credentials.');
    } finally {
      setLoading(false);
    }
  // ---------- Forgot Password ----------
  const forgotLink = document.getElementById('forgotPasswordLink');
  const forgotModal = document.getElementById('forgotPasswordModal');
  const forgotModalClose = document.getElementById('forgotModalClose');
  const forgotForm = document.getElementById('forgotPasswordForm');
  const forgotEmailInput = document.getElementById('forgotEmail');
  const forgotFeedback = document.getElementById('forgotFeedback');

  function openForgotModal() {
    if (!forgotModal) return;
    forgotModal.style.display = 'flex';
    if (forgotEmailInput) forgotEmailInput.value = '';
    if (forgotFeedback) {
      forgotFeedback.style.display = 'none';
      forgotFeedback.textContent = '';
    }
    setTimeout(() => forgotEmailInput && forgotEmailInput.focus(), 50);
  }

  function closeForgotModal() {
    if (forgotModal) forgotModal.style.display = 'none';
  }

  if (forgotLink) {
    forgotLink.addEventListener('click', (e) => {
      e.preventDefault();
      openForgotModal();
    });
  }
  if (forgotModalClose) {
    forgotModalClose.addEventListener('click', closeForgotModal);
  }
  if (forgotModal) {
    forgotModal.addEventListener('click', (e) => {
      if (e.target === forgotModal) closeForgotModal();
    });
  }
  if (forgotForm) {
    forgotForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!forgotEmailInput) return;
      const email = forgotEmailInput.value.trim().toLowerCase();
      if (!email) {
        if (forgotFeedback) {
          forgotFeedback.style.display = 'block';
          forgotFeedback.style.color = '#fca5a5';
          forgotFeedback.textContent = 'Please enter your email.';
        }
        return;
      }
      const submitBtn = forgotForm.querySelector('button[type="submit"]');
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Sending...';
      }
      try {
        const res = await apiRequest('/auth/forgot-password', 'POST', { email }, false);
        if (forgotFeedback) {
          forgotFeedback.style.display = 'block';
          forgotFeedback.style.color = '#86efac';
          forgotFeedback.textContent = res.message || 'If an account exists, a reset link has been sent.';
        }
        setTimeout(() => closeForgotModal(), 1800);
      } catch (err) {
        if (forgotFeedback) {
          forgotFeedback.style.display = 'block';
          forgotFeedback.style.color = '#fca5a5';
          forgotFeedback.textContent = err.message || 'Something went wrong. Please try again.';
        }
      } finally {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Send reset link';
        }
      }
    });
  }
});

});
