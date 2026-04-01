/**
 * memless Dashboard — HTML puro servido em GET /
 * Sem bundler, sem deps externas — funciona offline.
 * Auto-refresh a cada 5s via JS.
 * T5.1: status, memories, cache, searches, index jobs
 * T5.2: modal de edição inline de memórias
 */
export function renderDashboard(port: number): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>memless</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg:      #0d0d10;
      --surface: #16161c;
      --border:  #252530;
      --muted:   #6b6b85;
      --text:    #dcdce8;
      --accent:  #a78bfa;
      --green:   #4ade80;
      --yellow:  #facc15;
      --red:     #f87171;
      --radius:  6px;
    }
    body {
      font-family: ui-monospace, "Cascadia Code", "Fira Code", monospace;
      background: var(--bg); color: var(--text);
      padding: 1.5rem; min-height: 100vh;
    }
    header {
      display: flex; align-items: center; gap: .75rem;
      margin-bottom: 1.25rem;
    }
    header h1 { font-size: 1.1rem; color: var(--accent); }
    header small { color: var(--muted); font-size: .75rem; }
    #refresh-dot {
      width: 7px; height: 7px; border-radius: 50%;
      background: var(--green); margin-left: auto;
      animation: pulse 2s infinite;
    }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.3} }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: .85rem;
    }
    .card {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: var(--radius); padding: 1rem;
    }
    .card-full { grid-column: 1 / -1; }
    .card h2 {
      font-size: .7rem; color: var(--muted); text-transform: uppercase;
      letter-spacing: .1em; margin-bottom: .75rem;
    }

    table { width: 100%; border-collapse: collapse; font-size: .78rem; }
    th { color: var(--muted); text-align: left; padding: 3px 6px; border-bottom: 1px solid var(--border); }
    td { padding: 4px 6px; border-bottom: 1px solid #1b1b24; vertical-align: middle; }
    tr:last-child td { border-bottom: none; }
    td.truncate { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    .badge {
      display: inline-block; padding: 1px 7px; border-radius: 3px;
      font-size: .7rem; font-weight: 600;
    }
    .badge-ok   { background: #14532d; color: var(--green); }
    .badge-warn { background: #451a03; color: var(--yellow); }
    .badge-err  { background: #3f1111; color: var(--red); }
    .badge-type { background: #1e1b4b; color: #a5b4fc; }

    .imp-bar-wrap { width: 60px; height: 5px; background: var(--border); border-radius: 2px; display:inline-block; vertical-align:middle; }
    .imp-bar { height: 100%; border-radius: 2px; background: var(--accent); }

    button.icon-btn {
      background: none; border: 1px solid var(--border); color: var(--muted);
      border-radius: 3px; padding: 2px 6px; cursor: pointer; font-size: .7rem;
    }
    button.icon-btn:hover { border-color: var(--accent); color: var(--accent); }
    button.del-btn {
      background: #3f1111; border: none; color: var(--red);
      border-radius: 3px; padding: 2px 6px; cursor: pointer; font-size: .7rem;
    }
    button.del-btn:hover { background: #7f1d1d; }

    .progress-wrap { height: 5px; background: var(--border); border-radius: 2px; margin-top: 4px; }
    .progress-bar  { height: 100%; border-radius: 2px; background: var(--accent); transition: width .4s; }

    /* Modal — T5.2 */
    #modal-overlay {
      display: none; position: fixed; inset: 0;
      background: rgba(0,0,0,.65); z-index: 100;
      align-items: center; justify-content: center;
    }
    #modal-overlay.open { display: flex; }
    #modal {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: var(--radius); padding: 1.25rem;
      width: min(560px, 95vw); display: flex; flex-direction: column; gap: .75rem;
    }
    #modal h3 { font-size: .85rem; color: var(--accent); }
    #modal label { font-size: .72rem; color: var(--muted); display: block; margin-bottom: 3px; }
    #modal textarea {
      width: 100%; height: 120px; background: var(--bg); border: 1px solid var(--border);
      color: var(--text); border-radius: 3px; padding: .5rem; font-family: inherit;
      font-size: .78rem; resize: vertical;
    }
    #modal input[type=range] { width: 100%; accent-color: var(--accent); }
    #modal-imp-val { font-size: .72rem; color: var(--accent); }
    .modal-actions { display: flex; gap: .5rem; justify-content: flex-end; margin-top: .25rem; }
    .btn-save {
      background: var(--accent); color: #0d0d10; border: none;
      border-radius: 3px; padding: 4px 14px; cursor: pointer; font-size: .78rem;
    }
    .btn-cancel {
      background: none; border: 1px solid var(--border); color: var(--muted);
      border-radius: 3px; padding: 4px 10px; cursor: pointer; font-size: .78rem;
    }
    #toast {
      position: fixed; bottom: 1.5rem; right: 1.5rem;
      background: var(--surface); border: 1px solid var(--accent);
      color: var(--accent); padding: .5rem 1rem; border-radius: var(--radius);
      font-size: .78rem; opacity: 0; transition: opacity .3s;
      pointer-events: none;
    }
    #toast.show { opacity: 1; }
  </style>
</head>
<body>
  <header>
    <h1>⚡ memless</h1>
    <small>localhost:${port}</small>
    <div id="refresh-dot" title="auto-refresh 5s"></div>
  </header>

  <div class="grid" id="root"><td colspan="4" style="color:var(--muted);padding:1rem">loading…</td></div>

  <!-- Modal T5.2 -->
  <div id="modal-overlay">
    <div id="modal">
      <h3>Edit Memory</h3>
      <input type="hidden" id="modal-id">
      <div>
        <label>Content</label>
        <textarea id="modal-content"></textarea>
      </div>
      <div>
        <label>Importance: <span id="modal-imp-val">0.70</span></label>
        <input type="range" id="modal-imp" min="0" max="1" step="0.01" value="0.7">
      </div>
      <div class="modal-actions">
        <button class="btn-cancel" onclick="closeModal()">Cancel</button>
        <button class="btn-save"   onclick="saveModal()">Save</button>
      </div>
    </div>
  </div>

  <div id="toast"></div>

  <script>
    const BASE = '';
    let _memories = [];

    // ── Utilities ─────────────────────────────────────────────
    function esc(s) {
      return String(s ?? '')
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }
    function card(title, body, full) {
      return '<div class="card' + (full ? ' card-full' : '') + '"><h2>' + title + '</h2>' + body + '</div>';
    }
    function badge(text, cls) {
      return '<span class="badge badge-' + cls + '">' + esc(text) + '</span>';
    }
    function impBar(v) {
      const pct = Math.round((v ?? 0) * 100);
      const col = v >= 0.7 ? '#a78bfa' : v >= 0.4 ? '#facc15' : '#f87171';
      return '<div class="imp-bar-wrap"><div class="imp-bar" style="width:' + pct + '%;background:' + col + '"></div></div>';
    }
    function toast(msg) {
      const el = document.getElementById('toast');
      el.textContent = msg;
      el.classList.add('show');
      setTimeout(() => el.classList.remove('show'), 2200);
    }
    function fmtDate(ts) {
      return ts ? new Date(ts * 1000).toISOString().slice(0, 10) : '—';
    }

    // ── Modal T5.2 ────────────────────────────────────────────
    function openModal(id) {
      const m = _memories.find(x => x.id === id);
      if (!m) return;
      document.getElementById('modal-id').value      = id;
      document.getElementById('modal-content').value = m.content;
      const imp = document.getElementById('modal-imp');
      imp.value = m.importance ?? 0.7;
      document.getElementById('modal-imp-val').textContent = parseFloat(imp.value).toFixed(2);
      document.getElementById('modal-overlay').classList.add('open');
    }
    function closeModal() {
      document.getElementById('modal-overlay').classList.remove('open');
    }
    async function saveModal() {
      const id      = document.getElementById('modal-id').value;
      const content = document.getElementById('modal-content').value.trim();
      const imp     = parseFloat(document.getElementById('modal-imp').value);
      if (!content) return;
      try {
        const r = await fetch(BASE + '/api/memory/' + id, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content, importance: imp }),
        });
        if (!r.ok) throw new Error(await r.text());
        toast('✓ Memory updated');
        closeModal();
        load();
      } catch(e) { toast('✗ ' + e.message); }
    }
    document.getElementById('modal-imp').addEventListener('input', e => {
      document.getElementById('modal-imp-val').textContent = parseFloat(e.target.value).toFixed(2);
    });
    document.getElementById('modal-overlay').addEventListener('click', e => {
      if (e.target === e.currentTarget) closeModal();
    });

    // ── Delete ────────────────────────────────────────────────
    async function deleteMemory(id) {
      if (!confirm('Delete memory ' + id + '?')) return;
      try {
        await fetch(BASE + '/api/memory/' + id, { method: 'DELETE' });
        toast('✓ Deleted');
        load();
      } catch(e) { toast('✗ ' + e.message); }
    }

    // ── Main load ─────────────────────────────────────────────
    async function load() {
      try {
        const [health, analytics, cache, mems] = await Promise.all([
          fetch(BASE + '/health').then(r => r.json()).catch(() => ({})),
          fetch(BASE + '/api/analytics?type=summary').then(r => r.json()).catch(() => ({})),
          fetch(BASE + '/api/cache/stats').then(r => r.json()).catch(() => ({})),
          fetch(BASE + '/api/memory/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: 'project architecture decision pattern', limit: 50, minImportance: 0 }),
          }).then(r => r.json()).catch(() => ({ data: [] })),
        ]);

        _memories = mems.data ?? [];
        const a = analytics.data ?? {};
        const c = cache.data ?? {};
        const prov = health.provider ?? '—';

        const statusCard = card('Status', \`
          <table>
            <tr><th>server</th><td>\${badge('online :${port}','ok')}</td></tr>
            <tr><th>embeddings</th><td>\${esc(prov)}</td></tr>
            <tr><th>memories</th><td>\${_memories.length}</td></tr>
            <tr><th>cache L1</th><td>\${c.l1Size ?? '?'} entries</td></tr>
            <tr><th>cache L2</th><td>\${c.l2Size ?? '?'} entries</td></tr>
          </table>
        \`);

        const searchCard = card('Searches', \`
          <table>
            <tr><th>total</th><td>\${a.totalSearches ?? 0}</td></tr>
            <tr><th>avg latency</th><td>\${a.avgDurationMs ?? 0} ms</td></tr>
          </table>
          \${(a.topQueries ?? []).length ? \`
          <br>
          <table>
            <tr><th>query</th><th>×</th></tr>
            \${(a.topQueries ?? []).slice(0,6).map(q =>
              '<tr><td class=truncate>' + esc(q.query) + '</td><td>' + q.cnt + '</td></tr>'
            ).join('')}
          </table>\` : ''}
        \`);

        const typeColors = { decision:'#a78bfa', pattern:'#34d399', code:'#60a5fa', preference:'#fb923c', conversation:'#94a3b8' };
        const memCard = card('Memories (' + _memories.length + ')', \`
          <table>
            <tr><th>type</th><th>imp</th><th>date</th><th>content</th><th></th></tr>
            \${_memories.map(m => \`
              <tr>
                <td>\${badge(m.type, 'type')}</td>
                <td>\${impBar(m.importance)}<small style="font-size:.65rem;color:var(--muted);margin-left:4px">\${(m.importance??0).toFixed(2)}</small></td>
                <td style="color:var(--muted);font-size:.7rem">\${fmtDate(m.createdAt)}</td>
                <td class="truncate" style="max-width:260px">\${esc(m.content)}</td>
                <td style="white-space:nowrap">
                  <button class="icon-btn" onclick="openModal('\${m.id}')">edit</button>
                  <button class="del-btn"  onclick="deleteMemory('\${m.id}')">del</button>
                </td>
              </tr>
            \`).join('')}
          </table>
        \`, true);

        document.getElementById('root').innerHTML = [statusCard, searchCard, memCard].join('');
      } catch(e) {
        document.getElementById('root').innerHTML =
          '<div class="card"><h2>Error</h2><pre style="color:var(--red)">' + esc(String(e)) + '</pre></div>';
      }
    }

    load();
    setInterval(load, 5000);
  </script>
</body>
</html>`;
}
