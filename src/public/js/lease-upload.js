/**
 * Lease upload (same-origin script, allowed by the default CSP).
 * The app checks CSRF before routes run, and a multipart form's _csrf field can't
 * be read at that point, so this sends the token in the x-csrf-token header.
 * Without JavaScript the form stays hidden and a <noscript> note explains why.
 */
(() => {
  const form = document.getElementById('lease-upload');
  if (!form) return;
  form.hidden = false;
  const status = document.getElementById('lease-status');
  const button = form.querySelector('button[type="submit"]');
  const MAX_BYTES = 5 * 1024 * 1024;

  /**
   * Show an error. If the server marks part of the message as a link (details.linkText /
   * linkHref), that part becomes a real link. Built with text nodes, never innerHTML.
   */
  function showError(error) {
    const message = (error && error.message) || 'Something went wrong. Please try again.';
    const link = error && error.details;
    status.replaceChildren();
    const at = link && link.linkText ? message.indexOf(link.linkText) : -1;
    if (at < 0 || !String(link.linkHref).startsWith('/')) {
      status.textContent = message;
      return;
    }
    const a = document.createElement('a');
    a.href = link.linkHref;
    a.textContent = link.linkText;
    status.append(message.slice(0, at), a, message.slice(at + link.linkText.length));
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const file = form.querySelector('input[type="file"]').files[0];
    status.textContent = '';
    if (!file) return void (status.textContent = 'Choose a PDF file to upload.');
    if (file.size > MAX_BYTES) {
      return void (status.textContent = 'That file is over 5 MB. Upload a smaller PDF.');
    }
    const token = form.querySelector('input[name="_csrf"]').value;
    button.disabled = true;
    button.textContent = 'Reading your lease…';
    try {
      const res = await fetch(form.action, {
        method: 'POST',
        body: new FormData(form),
        headers: { 'x-csrf-token': token, Accept: 'application/json' },
        credentials: 'same-origin',
      });
      const body = await res.json().catch(() => null);
      if (res.ok && body && body.location) return void window.location.assign(body.location);
      showError(body && body.error);
    } catch {
      status.textContent = 'Network problem. Please try again.';
    }
    button.disabled = false;
    button.textContent = 'Summarize lease';
  });
})();
