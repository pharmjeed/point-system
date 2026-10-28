import { brand } from './catalog.js';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * Dev-only page (RTL Arabic): conversations per number, the W-01 button, handover codes.
 * Everything dynamic is rendered with textContent — message text never becomes markup.
 */
export function renderUi(): string {
  const b = brand();
  const title = `محاكي واتساب — ${b.customerNameAr}`;
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>
:root { --bg:#f3f4f6; --panel:#ffffff; --text:#111827; --muted:#6b7280; --line:#e5e7eb; --in:#ffffff; --out:#dcfce7;
  --accent:#0f766e; --accent-text:#ffffff; --warn-bg:#fef3c7; --warn-text:#92400e; --code-bg:#ecfeff; --code-text:#155e75; --fail:#b91c1c; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#0b1220; --panel:#111a2e; --text:#e5e7eb; --muted:#9ca3af; --line:#1f2a44; --in:#16213a; --out:#123a2c;
    --accent:#14b8a6; --accent-text:#04201c; --warn-bg:#3b2a07; --warn-text:#fcd34d; --code-bg:#0e3440; --code-text:#a5f3fc; --fail:#f87171; }
}
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--text); font: 15px/1.6 "IBM Plex Sans Arabic", system-ui, sans-serif; }
header { display:flex; flex-wrap:wrap; gap:8px 16px; align-items:center; padding:12px 16px; background:var(--panel); border-bottom:1px solid var(--line); }
header h1 { font-size:17px; margin:0; }
.badge { background:var(--warn-bg); color:var(--warn-text); border-radius:999px; padding:2px 10px; font-size:13px; }
.meta { color:var(--muted); font-size:13px; direction:ltr; unicode-bidi:isolate; }
main { display:grid; grid-template-columns: minmax(220px, 300px) 1fr; gap:12px; padding:12px 16px; max-width:1200px; margin:0 auto; }
@media (max-width: 720px) { main { grid-template-columns: 1fr; } }
section { background:var(--panel); border:1px solid var(--line); border-radius:12px; min-height:200px; overflow:hidden; }
section h2 { font-size:15px; margin:0; padding:10px 12px; border-bottom:1px solid var(--line); }
#list button { display:block; width:100%; text-align:start; background:none; border:0; border-bottom:1px solid var(--line); padding:10px 12px; color:inherit; font:inherit; cursor:pointer; }
#list button[aria-current="true"] { background:var(--code-bg); }
.num { direction:ltr; unicode-bidi:isolate; font-family: "IBM Plex Mono", ui-monospace, monospace; }
.small { color:var(--muted); font-size:13px; }
#thread { padding:12px; display:flex; flex-direction:column; gap:8px; max-height:65vh; overflow-y:auto; }
.bubble { max-width:min(520px, 92%); padding:8px 12px; border-radius:12px; white-space:pre-wrap; overflow-wrap:anywhere; border:1px solid var(--line); }
.bubble.out { align-self:flex-start; background:var(--in); }
.bubble.in { align-self:flex-end; background:var(--out); }
.bubble .foot { display:flex; gap:8px; justify-content:space-between; color:var(--muted); font-size:12px; margin-top:4px; }
.bubble .failed { color:var(--fail); }
.bubble .act { display:block; width:100%; margin-top:8px; padding:8px; border-radius:8px; border:1px solid var(--accent); background:var(--accent); color:var(--accent-text); font:inherit; cursor:pointer; }
.code { display:inline-block; margin-top:6px; padding:2px 10px; border-radius:8px; background:var(--code-bg); color:var(--code-text); font-family:"IBM Plex Mono", ui-monospace, monospace; font-size:18px; letter-spacing:2px; direction:ltr; }
form { display:flex; flex-wrap:wrap; gap:8px; padding:12px; border-top:1px solid var(--line); }
input { flex:1 1 160px; min-width:0; padding:8px 10px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--text); font:inherit; }
form button { padding:8px 14px; border-radius:8px; border:1px solid var(--line); background:var(--panel); color:var(--text); font:inherit; cursor:pointer; }
.empty { color:var(--muted); padding:16px 12px; }
#toast { position:fixed; inset-inline:16px; bottom:16px; margin:auto; max-width:480px; padding:10px 14px; border-radius:10px; background:var(--text); color:var(--bg); display:none; }
</style>
</head>
<body data-stop="${escapeHtml(b.stopKeyword)}">
<header>
  <h1>${escapeHtml(title)}</h1>
  <span class="badge">للتطوير والاختبار فقط — لا يراسل أي عميل حقيقي</span>
  <span class="meta" id="meta"></span>
</header>
<main>
  <section aria-labelledby="h-list"><h2 id="h-list">المحادثات</h2><div id="list"><p class="empty">لا توجد محادثات بعد.</p></div></section>
  <section aria-labelledby="h-thread">
    <h2 id="h-thread">اختر محادثة</h2>
    <div id="thread" aria-live="polite"></div>
    <form id="composer" hidden>
      <input id="body" name="body" autocomplete="off" placeholder="رسالة من العميل…" aria-label="نص الرسالة">
      <button type="submit">إرسال</button>
      <input id="code" name="code" autocomplete="off" placeholder="رمز الربط" aria-label="رمز الربط" maxlength="8" style="flex:0 1 120px">
      <button type="button" id="link">إرسال رمز الربط</button>
      <button type="button" id="stop">إيقاف الرسائل</button>
    </form>
  </section>
</main>
<div id="toast" role="status"></div>
<script>
(() => {
  const api = (path, body) => fetch('/_sim' + path, body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error((j.error && j.error.message) || ('HTTP ' + r.status)); return j; });
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const time = (iso) => new Date(iso).toLocaleTimeString('ar-SA-u-nu-latn', { timeZone: 'Asia/Riyadh', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const STATUS = { sent: '✓ أُرسلت', delivered: '✓✓ وصلت', read: '✓✓ قُرئت', failed: '! فشلت' };
  const toast = (msg) => { const t = document.getElementById('toast'); t.textContent = msg; t.style.display = 'block'; clearTimeout(toast.h); toast.h = setTimeout(() => { t.style.display = 'none'; }, 3500); };
  let current = null; let lastJson = '';

  async function refresh() {
    try {
      const [health, list] = await Promise.all([api('/health'), api('/conversations')]);
      document.getElementById('meta').textContent = 'phone_number_id ' + health.phoneNumberId + ' · webhook ' + (health.webhookUrl || '—') + ' · channel ' + health.channel;
      const box = document.getElementById('list');
      if (list.data.length === 0) { box.replaceChildren(el('p', 'empty', 'لا توجد محادثات بعد.')); }
      else {
        box.replaceChildren(...list.data.map((c) => {
          const b = el('button'); b.type = 'button'; b.setAttribute('aria-current', String(c.key === current));
          b.append(el('div', 'num', c.waId ? '+' + c.waId : c.userId), el('div', 'small', 'صادر ' + c.outbound + ' · وارد ' + c.inbound));
          if (c.claimCode) { const k = el('div', 'small'); k.append('رمز التسليم ', el('span', 'code', c.claimCode)); b.append(k); }
          b.onclick = () => { current = c.key; lastJson = ''; refresh(); };
          return b;
        }));
      }
      if (current) await renderThread();
    } catch (e) { document.getElementById('meta').textContent = String(e.message || e); }
  }

  async function renderThread() {
    const conv = await api('/conversations/' + encodeURIComponent(current));
    const json = JSON.stringify(conv.items);
    document.getElementById('h-thread').textContent = 'محادثة ' + (conv.waId ? '+' + conv.waId : conv.userId);
    document.getElementById('composer').hidden = false;
    if (json === lastJson) return; lastJson = json;
    const thread = document.getElementById('thread');
    if (conv.items.length === 0) { thread.replaceChildren(el('p', 'empty', 'لا توجد رسائل بعد.')); return; }
    thread.replaceChildren(...conv.items.map((m) => {
      const b = el('div', 'bubble ' + m.direction);
      b.append(el('div', null, m.text || '[' + m.kind + ']'));
      if (m.claimCode) { const c = el('div', null); c.append('رمز التسليم: ', el('span', 'code', m.claimCode)); b.append(c); }
      for (const btn of m.buttons || []) {
        const a = el('button', 'act', btn.text || 'زر'); a.type = 'button';
        a.onclick = () => api('/press', { wamid: m.wamid, buttonIndex: btn.index }).then((r) => toast('ضُغط الزر — webhook ' + r.deliveries.map((d) => d.httpStatus || d.error).join(', ')), (e) => toast(e.message));
        b.append(a);
      }
      const foot = el('div', 'foot');
      foot.append(el('span', null, (m.purpose ? m.purpose + ' · ' : '') + time(m.at)));
      if (m.status) foot.append(el('span', m.status === 'failed' ? 'failed' : null, STATUS[m.status] || m.status));
      b.append(foot);
      return b;
    }));
    thread.scrollTop = thread.scrollHeight;
  }

  const from = () => current;
  document.getElementById('composer').onsubmit = (ev) => {
    ev.preventDefault(); const input = document.getElementById('body'); const body = input.value.trim(); if (!body) return;
    api('/text', { from: from(), body }).then(() => { input.value = ''; refresh(); }, (e) => toast(e.message));
  };
  document.getElementById('link').onclick = () => {
    const code = document.getElementById('code').value.trim(); if (!code) return;
    api('/link-code', { from: from(), code }).then(() => refresh(), (e) => toast(e.message));
  };
  document.getElementById('stop').onclick = () => api('/stop', { from: from(), keyword: document.body.dataset.stop }).then(() => refresh(), (e) => toast(e.message));
  refresh(); setInterval(refresh, 1500);
})();
</script>
</body>
</html>`;
}
