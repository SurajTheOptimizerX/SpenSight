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
    showResult('Invalid link', 'No verification token was provided. Please check the link from your email.');
    return;
  }

  apiRequest(`/auth/verify?token=${encodeURIComponent(token)}`, 'GET', null, false)
    .then((data) => {
      showResult(
        'Email verified!',
        (data && data.message) || 'Your email has been verified. You can now log in to SpenSight.',
        'CircleCheck'
      );
    })
    .catch((error) => {
      showResult(
        'Verification failed',
        error.message || 'This verification link is invalid or has expired. Please register again or contact support.'
      );
    });
});
