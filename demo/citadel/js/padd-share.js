// Copy helper for the standalone /padd/share/... transfer page (no inline script, respects Citadel CSP).
const btn = document.getElementById('share-copy');
const box = document.getElementById('share-text');
if (btn && box) {
  btn.addEventListener('click', async () => {
    const text = box.value;
    let ok = false;
    if (navigator.clipboard && window.isSecureContext) {
      try { await navigator.clipboard.writeText(text); ok = true; } catch { /* fallback below */ }
    }
    if (!ok) {
      box.focus();
      box.select();
      try { ok = document.execCommand('copy'); } catch { ok = false; }
    }
    if (ok) {
      const orig = btn.textContent;
      btn.textContent = 'Copied';
      setTimeout(() => { btn.textContent = orig; }, 1800);
    }
  });
}
