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
    if (!submitBtn) return;
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

  // ---------- Login ----------
  if (loginForm) {
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
    });
  }

  // ---------- Forgot Password ----------
  const forgotLink = document.getElementById('forgotPasswordLink');
  const forgotModal = document.getElementById('forgotPasswordModal');
  const forgotModalClose = document.getElementById('forgotModalClose');
  const forgotForm = document.getElementById('forgotPasswordForm');
  const forgotEmailInput = document.getElementById('forgotEmail');
  const forgotFeedback = document.getElementById('forgotFeedback');
  const forgotSubmitBtn = forgotForm ? forgotForm.querySelector('button[type="submit"]') : null;
  let forgotCloseTimer = null;
  let forgotCountdownTimer = null;

  const FEEDBACK_STYLES = {
    success: {
      color: '#86efac',
      background: 'rgba(34, 197, 94, 0.15)',
      border: '1px solid rgba(34, 197, 94, 0.3)',
    },
    neutral: {
      color: 'var(--text-muted)',
      background: 'rgba(148, 163, 184, 0.1)',
      border: '1px solid rgba(148, 163, 184, 0.25)',
    },
    error: {
      color: '#fca5a5',
      background: 'rgba(239, 68, 68, 0.15)',
      border: '1px solid rgba(239, 68, 68, 0.3)',
    },
  };

  function setForgotFeedback(kind, message) {
    if (!forgotFeedback) return;
    const style = FEEDBACK_STYLES[kind] || FEEDBACK_STYLES.neutral;
    forgotFeedback.style.display = 'block';
    forgotFeedback.style.color = style.color;
    forgotFeedback.style.background = style.background;
    forgotFeedback.style.border = style.border;
    forgotFeedback.style.borderRadius = '8px';
    forgotFeedback.style.padding = '8px 10px';
    forgotFeedback.style.wordBreak = 'break-word';
    forgotFeedback.textContent = message;
  }

  function clearTimers() {
    if (forgotCloseTimer) {
      clearTimeout(forgotCloseTimer);
      forgotCloseTimer = null;
    }
    if (forgotCountdownTimer) {
      clearInterval(forgotCountdownTimer);
      forgotCountdownTimer = null;
    }
  }

  function resetForgotForm() {
    clearTimers();
    if (forgotEmailInput) {
      forgotEmailInput.disabled = false;
      forgotEmailInput.value = '';
    }
    if (forgotSubmitBtn) {
      forgotSubmitBtn.disabled = false;
      forgotSubmitBtn.textContent = 'Send reset link';
    }
    if (forgotFeedback) {
      forgotFeedback.style.display = 'none';
      forgotFeedback.textContent = '';
    }
  }

  function closeForgotModal() {
    clearTimers();
    if (forgotModal) forgotModal.style.display = 'none';
    setTimeout(resetForgotForm, 200);
  }

  function openForgotModal() {
    if (!forgotModal) return;
    resetForgotForm();
    forgotModal.style.display = 'flex';
    setTimeout(() => forgotEmailInput && forgotEmailInput.focus(), 50);
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
      e.stopPropagation();
      if (!forgotEmailInput) return;

      const email = String(forgotEmailInput.value || '').trim().toLowerCase();
      if (!email) {
        setForgotFeedback('error', 'Please enter your email.');
        forgotEmailInput.focus();
        return;
      }

      if (forgotSubmitBtn) {
        forgotSubmitBtn.disabled = true;
        forgotSubmitBtn.textContent = 'Sending...';
      }

      try {
        const apiUrl =
          (typeof API_BASE_URL !== 'undefined'
            ? API_BASE_URL
            : 'https://spensight.onrender.com/api') + '/auth/forgot-password';
        const response = await fetch(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        });

        let data = {};
        try {
          data = await response.json();
        } catch (parseErr) {
          data = {};
        }

        if (response.ok && data.success) {
          setForgotFeedback('success', data.message || 'Check your inbox! We sent a password reset link.');
          forgotEmailInput.disabled = true;
          if (forgotSubmitBtn) {
            forgotSubmitBtn.textContent = 'Email Sent!';
            forgotSubmitBtn.style.background = '#16a34a';
            forgotSubmitBtn.style.borderColor = '#16a34a';
          }

          let remaining = 5;
          forgotFeedback.textContent = `${forgotFeedback.textContent} Closing in ${remaining}s...`;
          forgotCountdownTimer = setInterval(() => {
            remaining -= 1;
            if (remaining <= 0) {
              clearInterval(forgotCountdownTimer);
              forgotCountdownTimer = null;
              return;
            }
            if (forgotFeedback) {
              forgotFeedback.textContent = `${data.message || 'Check your inbox! We sent a password reset link.'} Closing in ${remaining}s...`;
            }
            if (forgotSubmitBtn && remaining <= 5) {
              forgotSubmitBtn.textContent = `Email Sent! (${remaining}s)`;
            }
          }, 1000);
          forgotCloseTimer = setTimeout(() => closeForgotModal(), 5000);
          return;
        }

        if (response.ok) {
          setForgotFeedback('neutral', data.message || 'If an account exists, a reset link has been sent.');
          return;
        }

        setForgotFeedback('error', data.error || data.message || 'Failed to send the reset email. Please try again.');
      } catch (err) {
        console.error('Forgot password request failed:', err);
        setForgotFeedback('error', (err && err.message) || 'Something went wrong. Please check your connection.');
      } finally {
        if (forgotSubmitBtn && !forgotSubmitBtn.textContent.includes('Email Sent!')) {
          forgotSubmitBtn.disabled = false;
          forgotSubmitBtn.textContent = 'Send reset link';
          forgotSubmitBtn.style.background = '';
          forgotSubmitBtn.style.borderColor = '';
        }
      }
    });
  }
});
