document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('[data-icon]').forEach((el) => {
    el.innerHTML = SpenIcons.icon(el.getAttribute('data-icon'));
  });

  if (!getToken()) {
    window.location.href = 'login.html';
    return;
  }

  const form = document.getElementById('mailSettingsForm');
  const statusBanner = document.getElementById('statusBanner');
  const statusText = document.getElementById('statusText');
  const saveBtn = document.getElementById('saveBtn');
  const testBtn = document.getElementById('testBtn');
  const testEmail = document.getElementById('testEmail');
  const toastContainer = document.getElementById('toastContainer');

  function getField(id) {
    return document.getElementById(id);
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

  function setStatus(message, type = 'warn') {
    statusBanner.className = `status-banner status-${type}`;
    statusText.textContent = message;
    const iconName = type === 'ok' ? 'CircleCheck' : type === 'error' ? 'AlertTriangle' : 'Settings';
    const icon = statusBanner.querySelector('[data-icon]');
    if (icon) icon.innerHTML = SpenIcons.icon(iconName);
  }

  function hydrate(el) {
    el.querySelectorAll('[data-icon]').forEach((iconEl) => {
      iconEl.innerHTML = SpenIcons.icon(iconEl.getAttribute('data-icon'));
    });
  }

  function setSaving(loading) {
    saveBtn.disabled = loading;
    saveBtn.innerHTML = loading
      ? '<span data-icon="RefreshCw" style="width:16px;height:16px;animation:spin 1s linear infinite;"></span> Saving...'
      : '<span data-icon="Check"></span> Save Settings';
    hydrate(saveBtn);
  }

  function setTesting(loading) {
    testBtn.disabled = loading;
    testBtn.innerHTML = loading
      ? '<span data-icon="RefreshCw" style="width:16px;height:16px;animation:spin 1s linear infinite;"></span> Sending...'
      : '<span data-icon="Send"></span> Test';
    hydrate(testBtn);
  }

  async function loadSettings() {
    try {
      const data = await apiRequest('/settings/mail', 'GET');
      const s = data.settings;
      getField('mailHost').value = s.host || '';
      getField('mailPort').value = s.port || 587;
      getField('mailUser').value = s.user || '';
      getField('mailFrom').value = s.from || '';
      getField('mailAppName').value = s.appName || '';
      getField('mailVerifyUrl').value = s.verifyPageUrl || '';

      if (s.configured) {
        setStatus(`SMTP ready — sending via ${s.host}.`, 'ok');
      } else {
        setStatus('SMTP not configured. Verification emails fall back to the server console.', 'warn');
      }
    } catch (error) {
      if (error && error.message === 'Admin access required.') {
        setStatus('Admin access required. Only users in the ADMIN_EMAILS list can edit mail settings.', 'error');
        if (form) form.style.display = 'none';
      } else {
        setStatus(error.message || 'Failed to load mail settings.', 'error');
      }
    }
  }

  if (!form) return;
  loadSettings();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const payload = {
      host: getField('mailHost').value.trim(),
      port: getField('mailPort').value.trim(),
      user: getField('mailUser').value.trim(),
      password: getField('mailPass').value,
      from: getField('mailFrom').value.trim(),
      appName: getField('mailAppName').value.trim(),
      verifyPageUrl: getField('mailVerifyUrl').value.trim(),
    };

    if (!payload.host || !payload.user) {
      showToast('SMTP host and username are required to send email.');
      return;
    }

    setSaving(true);

    try {
      const data = await apiRequest('/settings/mail', 'PUT', payload);
      showToast('Mail settings saved.', 'success');
      getField('mailPass').value = '';
      if (data.settings.configured) {
        setStatus(`SMTP ready — sending via ${data.settings.host}.`, 'ok');
      } else {
        setStatus('SMTP not configured. Verification emails fall back to the server console.', 'warn');
      }
    } catch (error) {
      showToast(error.message || 'Failed to save settings.');
    } finally {
      setSaving(false);
    }
  });

  testBtn.addEventListener('click', async () => {
    const to = testEmail.value.trim();
    if (!to) {
      showToast('Enter a recipient email address for the test.');
      return;
    }

    setTesting(true);

    try {
      const data = await apiRequest('/settings/mail/test', 'POST', { to });
      showToast(data.message || 'Test email sent.', 'success');
    } catch (error) {
      showToast(error.message || 'Test email failed.');
      setStatus(error.message || 'Test email failed.', 'error');
    } finally {
      setTesting(false);
    }
  });
});
