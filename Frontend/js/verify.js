document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('[data-icon]').forEach((el) => {
    el.innerHTML = SpenIcons.icon(el.getAttribute('data-icon'));
  });

  const title = document.getElementById('verifyTitle');
  const message = document.getElementById('verifyMessage');
  const spinner = document.getElementById('verifySpinner');
  const loginBtn = document.getElementById('verifyLoginBtn');
  const verifyIcon = document.getElementById('verifyIcon');

  function showResult(heading, text, iconName) {
    title.textContent = heading;
    message.textContent = text;
    if (spinner) spinner.style.display = 'none';
    if (loginBtn) loginBtn.style.display = 'flex';
    if (verifyIcon && iconName) verifyIcon.innerHTML = SpenIcons.icon(iconName);
  }

  const params = new URLSearchParams(window.location.search);
  const token = params.get('token') || '';

  if (!token) {
    showResult('Invalid link', 'Invalid or expired verification link.');
    return;
  }

  apiRequest(`/auth/verify?token=${encodeURIComponent(token)}`, 'GET', null, false)
    .then((data) => {
      showResult('Email verified!', (data && data.message) || 'Email verified successfully!', 'CircleCheck');
    })
    .catch((error) => {
      showResult('Verification failed', error.message || 'Invalid or expired verification link.');
    });
});
