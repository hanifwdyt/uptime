import { Hono } from "hono";
import { PrismaClient } from "@prisma/client";
import { getCookie, setCookie } from "hono/cookie";
import {
  getQR,
  getStatus,
  listGroups,
  disconnect,
  reconnect,
} from "./whatsapp";
import { startMonitor, stopMonitor } from "./monitor";
import { formatDuration, formatUptime } from "./utils";

const prisma = new PrismaClient();
const app = new Hono();

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme";
const SESSION_TOKEN = Buffer.from(ADMIN_PASSWORD).toString("base64");

// Auth middleware
function isAuthed(c: any): boolean {
  return getCookie(c, "token") === SESSION_TOKEN;
}

function requireAuth(c: any): Response | null {
  if (!isAuthed(c)) return c.redirect("/");
  return null;
}

// ========================
// API Routes
// ========================

app.post("/api/auth", async (c) => {
  const body = await c.req.parseBody();
  if (body.password === ADMIN_PASSWORD) {
    setCookie(c, "token", SESSION_TOKEN, {
      httpOnly: true,
      sameSite: "Lax",
      maxAge: 60 * 60 * 24 * 30,
      path: "/",
    });
    return c.redirect("/dashboard");
  }
  return c.redirect("/?error=1");
});

app.get("/api/websites", async (c) => {
  const auth = requireAuth(c);
  if (auth) return auth;

  const websites = await prisma.website.findMany({
    orderBy: { createdAt: "asc" },
  });

  const result = await Promise.all(
    websites.map(async (w) => {
      const total = await prisma.check.count({ where: { websiteId: w.id } });
      const up = await prisma.check.count({
        where: { websiteId: w.id, status: "up" },
      });
      return { ...w, uptimePercent: formatUptime(total, up) };
    })
  );

  return c.json(result);
});

app.post("/api/websites", async (c) => {
  const auth = requireAuth(c);
  if (auth) return auth;

  const body = await c.req.json();
  const website = await prisma.website.create({
    data: {
      url: body.url,
      name: body.name,
      checkInterval: body.checkInterval || 60,
      notifyType: body.notifyType || "personal",
      notifyTarget: body.notifyTarget || "",
      downTemplate: body.downTemplate || null,
      upTemplate: body.upTemplate || null,
    },
  });

  // Restart monitor to pick up new website
  await startMonitor();
  return c.json(website, 201);
});

app.put("/api/websites/:id", async (c) => {
  const auth = requireAuth(c);
  if (auth) return auth;

  const id = c.req.param("id");
  const body = await c.req.json();
  const website = await prisma.website.update({
    where: { id },
    data: {
      url: body.url,
      name: body.name,
      checkInterval: body.checkInterval,
      isActive: body.isActive,
      notifyType: body.notifyType,
      notifyTarget: body.notifyTarget,
      downTemplate: body.downTemplate || null,
      upTemplate: body.upTemplate || null,
    },
  });

  await startMonitor();
  return c.json(website);
});

app.delete("/api/websites/:id", async (c) => {
  const auth = requireAuth(c);
  if (auth) return auth;

  const id = c.req.param("id");
  await prisma.website.delete({ where: { id } });
  await startMonitor();
  return c.json({ ok: true });
});

app.get("/api/websites/:id", async (c) => {
  const auth = requireAuth(c);
  if (auth) return auth;

  const id = c.req.param("id");
  const website = await prisma.website.findUnique({ where: { id } });
  if (!website) return c.json({ error: "Not found" }, 404);

  const recentChecks = await prisma.check.findMany({
    where: { websiteId: id },
    orderBy: { checkedAt: "desc" },
    take: 100,
  });

  const incidents = await prisma.incident.findMany({
    where: { websiteId: id },
    orderBy: { startedAt: "desc" },
    take: 50,
  });

  // Compute uptime for different periods
  const now = Date.now();
  const periods = [
    { label: "24h", ms: 24 * 60 * 60 * 1000 },
    { label: "7d", ms: 7 * 24 * 60 * 60 * 1000 },
    { label: "30d", ms: 30 * 24 * 60 * 60 * 1000 },
  ];

  const uptimes: Record<string, string> = {};
  for (const p of periods) {
    const since = new Date(now - p.ms);
    const total = await prisma.check.count({
      where: { websiteId: id, checkedAt: { gte: since } },
    });
    const up = await prisma.check.count({
      where: { websiteId: id, status: "up", checkedAt: { gte: since } },
    });
    uptimes[p.label] = formatUptime(total, up);
  }

  return c.json({ website, recentChecks, incidents, uptimes });
});

// WA API routes
app.get("/api/wa/status", async (c) => {
  const auth = requireAuth(c);
  if (auth) return auth;
  return c.json(getStatus());
});

app.get("/api/wa/qr", async (c) => {
  const auth = requireAuth(c);
  if (auth) return auth;
  return c.json({ qr: getQR() });
});

app.post("/api/wa/disconnect", async (c) => {
  const auth = requireAuth(c);
  if (auth) return auth;
  await disconnect();
  return c.json({ ok: true });
});

app.post("/api/wa/reconnect", async (c) => {
  const auth = requireAuth(c);
  if (auth) return auth;
  await reconnect();
  return c.json({ ok: true });
});

app.get("/api/wa/groups", async (c) => {
  const auth = requireAuth(c);
  if (auth) return auth;
  const groups = await listGroups();
  return c.json(groups);
});

// Settings API
app.get("/api/settings", async (c) => {
  const auth = requireAuth(c);
  if (auth) return auth;

  const settings = await prisma.setting.findMany();
  const result: Record<string, string> = {};
  for (const s of settings) result[s.key] = s.value;
  return c.json(result);
});

app.post("/api/settings", async (c) => {
  const auth = requireAuth(c);
  if (auth) return auth;

  const body = await c.req.json();
  const allowedKeys = [
    "defaultNotifyType",
    "defaultNotifyTarget",
    "defaultDownTemplate",
    "defaultUpTemplate",
  ];

  for (const key of allowedKeys) {
    if (key in body) {
      const value = body[key] || "";
      await prisma.setting.upsert({
        where: { key },
        update: { value },
        create: { key, value },
      });
    }
  }

  return c.json({ ok: true });
});

// ========================
// HTML Pages
// ========================

const CSS = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Inter', -apple-system, sans-serif; background: #0f0f0f; color: #e0e0e0; min-height: 100vh; }
  a { color: #8b5cf6; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
  .card { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 12px; padding: 24px; margin-bottom: 16px; }
  .btn { background: #8b5cf6; color: white; border: none; padding: 10px 20px; border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: 500; transition: background 0.2s; }
  .btn:hover { background: #7c3aed; }
  .btn-danger { background: #ef4444; }
  .btn-danger:hover { background: #dc2626; }
  .btn-sm { padding: 6px 12px; font-size: 12px; }
  .btn-ghost { background: transparent; border: 1px solid #333; color: #999; }
  .btn-ghost:hover { border-color: #555; color: #ccc; }
  input, select, textarea { background: #111; border: 1px solid #333; color: #e0e0e0; padding: 10px 14px; border-radius: 8px; font-size: 14px; width: 100%; }
  input:focus, select:focus, textarea:focus { outline: none; border-color: #8b5cf6; }
  textarea { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 13px; resize: vertical; min-height: 80px; }
  .nav { display: flex; gap: 20px; align-items: center; padding: 16px 0; margin-bottom: 20px; border-bottom: 1px solid #222; }
  .nav-brand { font-size: 18px; font-weight: 700; color: #8b5cf6; }
  .nav a { color: #888; font-size: 14px; }
  .nav a:hover { color: #e0e0e0; text-decoration: none; }
  .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin-bottom: 20px; }
  .stat-card { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 12px; padding: 20px; }
  .stat-value { font-size: 28px; font-weight: 700; }
  .stat-label { font-size: 12px; color: #888; margin-top: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; padding: 12px; font-size: 12px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 1px solid #222; }
  td { padding: 12px; border-bottom: 1px solid #1a1a1a; font-size: 14px; }
  tr:hover { background: #151515; }
  .dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
  .dot-up { background: #22c55e; box-shadow: 0 0 6px #22c55e55; }
  .dot-down { background: #ef4444; box-shadow: 0 0 6px #ef444455; }
  .dot-unknown { background: #666; }
  .badge { padding: 4px 10px; border-radius: 20px; font-size: 12px; font-weight: 500; }
  .badge-up { background: #22c55e22; color: #22c55e; }
  .badge-down { background: #ef444422; color: #ef4444; }
  .modal-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.7); z-index: 100; justify-content: center; align-items: center; }
  .modal-overlay.active { display: flex; }
  .modal { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 12px; padding: 32px; width: 100%; max-width: 500px; max-height: 90vh; overflow-y: auto; }
  .modal h3 { margin-bottom: 20px; }
  .form-group { margin-bottom: 16px; }
  .form-group label { display: block; font-size: 13px; color: #888; margin-bottom: 6px; }
  .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .text-green { color: #22c55e; }
  .text-red { color: #ef4444; }
  .text-muted { color: #666; }
  .login-wrapper { display: flex; justify-content: center; align-items: center; min-height: 100vh; }
  .login-card { width: 100%; max-width: 380px; }
  .qr-container { text-align: center; padding: 40px; }
  .qr-container img { border-radius: 12px; }
  .spinner { display: inline-block; width: 40px; height: 40px; border: 3px solid #333; border-top: 3px solid #8b5cf6; border-radius: 50%; animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .search-bar { margin-bottom: 16px; }
  .flex { display: flex; }
  .flex-between { display: flex; justify-content: space-between; align-items: center; }
  .gap-2 { gap: 8px; }
  .mb-2 { margin-bottom: 8px; }
  .mb-4 { margin-bottom: 16px; }
  .mt-4 { margin-top: 16px; }
  .collapsible-header { cursor: pointer; display: flex; align-items: center; gap: 8px; color: #888; font-size: 13px; user-select: none; padding: 8px 0; }
  .collapsible-header:hover { color: #ccc; }
  .collapsible-header .arrow { transition: transform 0.2s; }
  .collapsible-header.open .arrow { transform: rotate(90deg); }
  .collapsible-body { display: none; }
  .collapsible-body.open { display: block; }
  .var-ref { font-size: 12px; color: #666; background: #111; padding: 8px 12px; border-radius: 6px; margin-top: 8px; }
  .var-ref code { color: #8b5cf6; }

  /* Nav layout */
  .nav-toggle { display: none; background: none; border: 1px solid #333; color: #e0e0e0; font-size: 20px; padding: 6px 12px; border-radius: 8px; cursor: pointer; line-height: 1; }
  .nav-toggle:hover { border-color: #8b5cf6; color: #fff; }
  .nav-links { display: flex; gap: 20px; align-items: center; }
  .nav { justify-content: flex-start; }
  .nav-brand { margin-right: auto; }

  /* ===== TABLET (max 768px) ===== */
  @media (max-width: 768px) {
    /* Nav → hamburger */
    .nav { flex-wrap: wrap; gap: 12px; }
    .nav-brand { margin-right: 0; flex: 1; }
    .nav-toggle { display: block; }
    .nav-links { display: none; width: 100%; flex-direction: column; gap: 0; background: #151515; border-radius: 8px; overflow: hidden; }
    .nav-links.open { display: flex; }
    .nav-links a { display: block; padding: 12px 16px; color: #aaa; border-bottom: 1px solid #222; font-size: 15px; }
    .nav-links a:hover { background: #1a1a1a; color: #e0e0e0; text-decoration: none; }
    .nav-links a:last-child { border-bottom: none; }

    /* Layout */
    .container { padding: 12px; }
    .stats-grid { grid-template-columns: repeat(2, 1fr); gap: 8px; }
    .stat-card { padding: 14px; }
    .stat-value { font-size: 22px; }

    /* Search + Add button row */
    .flex-between { flex-direction: column; gap: 10px; align-items: stretch; }
    .flex-between input[type="text"] { max-width: 100% !important; }

    /* Forms */
    .form-row { grid-template-columns: 1fr; }
    input, select, textarea { font-size: 16px; padding: 12px 14px; }
    .btn { padding: 12px 20px; font-size: 15px; }
    .btn-sm { padding: 8px 14px; font-size: 13px; }

    /* Modal */
    .modal-overlay { align-items: flex-end; }
    .modal { margin: 0; max-width: 100%; border-radius: 16px 16px 0 0; padding: 24px 16px; max-height: 85vh; }

    /* ---- Table → Card layout ---- */
    .responsive-table { padding: 0 !important; border: none !important; background: transparent !important; }
    .responsive-table table { border-collapse: separate; border-spacing: 0; }
    .responsive-table table thead { display: none; }
    .responsive-table table,
    .responsive-table table tbody,
    .responsive-table table tr,
    .responsive-table table td { display: block; width: 100%; }
    .responsive-table table tbody { display: flex; flex-direction: column; gap: 8px; padding: 12px; }
    .responsive-table table tr { padding: 14px; border: 1px solid #2a2a2a; border-radius: 10px; background: #1a1a1a; }
    .responsive-table table tr:hover { background: #1e1e1e; }
    .responsive-table table td { padding: 5px 0; border: none; font-size: 14px; }
    /* Label-value rows */
    .responsive-table table td[data-label] { display: grid; grid-template-columns: 100px 1fr; gap: 8px; align-items: baseline; }
    .responsive-table table td[data-label]::before { content: attr(data-label); font-size: 11px; color: #555; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; }
    /* Name cell = full width, no label, prominent */
    .responsive-table table td[data-label="Name"] { display: block; padding-bottom: 8px; margin-bottom: 4px; border-bottom: 1px solid #222; }
    .responsive-table table td[data-label="Name"]::before { display: none; }
    .responsive-table table td[data-label="Name"] a { font-size: 15px; }
    /* URL cell — truncate */
    .responsive-table table td[data-label="URL"] { overflow: hidden; }
    .responsive-table table td[data-label="URL"] > * { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    /* Actions cell */
    .responsive-table table td[data-label="Actions"] { display: flex; gap: 8px; padding-top: 10px; margin-top: 6px; border-top: 1px solid #222; }
    .responsive-table table td[data-label="Actions"]::before { display: none; }
    .responsive-table table td[data-label="Actions"] .btn { flex: 1; text-align: center; }
    /* Group Name cell */
    .responsive-table table td[data-label="Group Name"] { display: block; padding-bottom: 6px; font-weight: 500; }
    .responsive-table table td[data-label="Group Name"]::before { display: none; }
    /* JID cell */
    .responsive-table table td[data-label="JID"] code { font-size: 11px; word-break: break-all; }

    /* Login */
    .login-card { margin: 16px; }

    /* Detail page */
    .card p { font-size: 14px; line-height: 1.8; }
    .qr-container { padding: 24px; }
    .qr-container img { max-width: 260px; }
  }

  /* ===== SMALL PHONE (max 400px) ===== */
  @media (max-width: 400px) {
    .stats-grid { grid-template-columns: 1fr; }
    .stat-card { display: flex; justify-content: space-between; align-items: center; padding: 12px 14px; }
    .stat-value { font-size: 20px; }
    .stat-label { margin-top: 0; }
    .responsive-table table td[data-label] { grid-template-columns: 80px 1fr; }
  }
`;

function layout(title: string, body: string, nav = true): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — Uptime Monitor</title>
  <style>${CSS}</style>
</head>
<body>
  ${
    nav
      ? `<div class="container">
    <div class="nav">
      <span class="nav-brand">Uptime Monitor</span>
      <button class="nav-toggle" onclick="document.querySelector('.nav-links').classList.toggle('open');this.textContent=this.textContent==='☰'?'✕':'☰';" aria-label="Toggle menu">☰</button>
      <div class="nav-links">
        <a href="/dashboard">Dashboard</a>
        <a href="/settings">Settings</a>
        <a href="/wa">WhatsApp</a>
        <a href="/" onclick="document.cookie='token=;path=/;max-age=0';return true;">Logout</a>
      </div>
    </div>
  </div>`
      : ""
  }
  ${body}
</body>
</html>`;
}

// Login page
app.get("/", (c) => {
  if (isAuthed(c)) return c.redirect("/dashboard");
  const error = c.req.query("error");
  const html = layout(
    "Login",
    `<div class="login-wrapper">
      <div class="card login-card">
        <h2 style="margin-bottom:24px;text-align:center;">Uptime Monitor</h2>
        ${error ? '<p style="color:#ef4444;text-align:center;margin-bottom:16px;">Wrong password</p>' : ""}
        <form method="POST" action="/api/auth">
          <div class="form-group">
            <label>Password</label>
            <input type="password" name="password" placeholder="Enter admin password" autofocus>
          </div>
          <button type="submit" class="btn" style="width:100%;">Login</button>
        </form>
      </div>
    </div>`,
    false
  );
  return c.html(html);
});

// Dashboard page
app.get("/dashboard", async (c) => {
  const auth = requireAuth(c);
  if (auth) return auth;

  const html = layout(
    "Dashboard",
    `<div class="container">
      <div class="stats-grid" id="stats">
        <div class="stat-card"><div class="stat-value" id="stat-total">-</div><div class="stat-label">Total Sites</div></div>
        <div class="stat-card"><div class="stat-value text-green" id="stat-up">-</div><div class="stat-label">Up</div></div>
        <div class="stat-card"><div class="stat-value text-red" id="stat-down">-</div><div class="stat-label">Down</div></div>
        <div class="stat-card"><div class="stat-value" id="stat-avg">-</div><div class="stat-label">Avg Response</div></div>
      </div>

      <div class="flex-between mb-4">
        <input type="text" id="search" placeholder="Search websites..." style="max-width:300px;" oninput="filterTable()">
        <button class="btn" onclick="openModal()">+ Add Website</button>
      </div>

      <div class="card responsive-table" style="padding:0;overflow:hidden;">
        <table>
          <thead>
            <tr><th>Name</th><th>URL</th><th>Status</th><th>Response</th><th>Uptime</th><th>Notify</th><th>Actions</th></tr>
          </thead>
          <tbody id="website-table"></tbody>
        </table>
      </div>

      <!-- Add/Edit Modal -->
      <div class="modal-overlay" id="modal">
        <div class="modal">
          <h3 id="modal-title">Add Website</h3>
          <input type="hidden" id="edit-id">
          <div class="form-group">
            <label>Name</label>
            <input type="text" id="f-name" placeholder="My Website">
          </div>
          <div class="form-group">
            <label>URL</label>
            <input type="text" id="f-url" placeholder="https://example.com">
          </div>
          <div class="form-row">
            <div class="form-group">
              <label>Check Interval</label>
              <select id="f-interval-preset" onchange="toggleCustomInterval()">
                <option value="10">10s (Aggressive)</option>
                <option value="30">30s (Frequent)</option>
                <option value="60" selected>60s (Recommended)</option>
                <option value="300">5m (Relaxed)</option>
                <option value="custom">Custom...</option>
              </select>
              <input type="number" id="f-interval-custom" value="60" min="10" style="display:none;margin-top:8px;" placeholder="Seconds (min 10)">
            </div>
            <div class="form-group">
              <label>Notify Type</label>
              <select id="f-notifyType">
                <option value="personal">Personal</option>
                <option value="group">Group</option>
              </select>
            </div>
          </div>
          <div class="form-group">
            <label>Notify Target <span class="text-muted">(phone number or group JID)</span></label>
            <input type="text" id="f-notifyTarget" placeholder="628xxxxxxxxx">
          </div>
          <div class="form-group">
            <label>Active</label>
            <select id="f-isActive">
              <option value="true">Yes</option>
              <option value="false">No</option>
            </select>
          </div>

          <!-- Custom Templates (collapsible) -->
          <div style="margin-top:8px;">
            <div class="collapsible-header" onclick="toggleTemplates()">
              <span class="arrow" id="tpl-arrow">&#9654;</span>
              <span>Custom Notification Templates</span>
            </div>
            <div class="collapsible-body" id="tpl-body">
              <div class="form-group">
                <label>DOWN Template <span class="text-muted">(leave empty for default)</span></label>
                <textarea id="f-downTemplate" rows="3" placeholder="🔴 *{name}* is DOWN&#10;URL: {url}&#10;Error: {error}&#10;Time: {time}"></textarea>
              </div>
              <div class="form-group">
                <label>UP Template <span class="text-muted">(leave empty for default)</span></label>
                <textarea id="f-upTemplate" rows="3" placeholder="🟢 *{name}* is back UP&#10;URL: {url}&#10;Downtime: {downtime}&#10;Time: {time}"></textarea>
              </div>
              <div class="var-ref">
                Variables: <code>{name}</code> <code>{url}</code> <code>{error}</code> <code>{statusCode}</code> <code>{downtime}</code> <code>{time}</code>
              </div>
            </div>
          </div>

          <div class="flex gap-2" style="margin-top:20px;">
            <button class="btn" onclick="saveWebsite()">Save</button>
            <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
          </div>
        </div>
      </div>
    </div>

    <script>
      let websites = [];
      let defaultSettings = {};

      async function loadSettings() {
        try {
          const res = await fetch('/api/settings');
          defaultSettings = await res.json();
        } catch(e) {}
      }

      async function load() {
        const res = await fetch('/api/websites');
        websites = await res.json();
        render();
      }

      function render() {
        const up = websites.filter(w => w.lastStatus === 'up').length;
        const down = websites.filter(w => w.lastStatus === 'down').length;
        const avg = websites.length > 0
          ? Math.round(websites.filter(w => w.lastResponseMs).reduce((a, w) => a + (w.lastResponseMs || 0), 0) / Math.max(websites.filter(w => w.lastResponseMs).length, 1))
          : 0;

        document.getElementById('stat-total').textContent = websites.length;
        document.getElementById('stat-up').textContent = up;
        document.getElementById('stat-down').textContent = down;
        document.getElementById('stat-avg').textContent = avg ? avg + 'ms' : '-';

        filterTable();
      }

      function filterTable() {
        const q = document.getElementById('search').value.toLowerCase();
        const filtered = websites.filter(w => w.name.toLowerCase().includes(q) || w.url.toLowerCase().includes(q));
        const tbody = document.getElementById('website-table');
        tbody.innerHTML = filtered.map(w => {
          const dotClass = w.lastStatus === 'up' ? 'dot-up' : w.lastStatus === 'down' ? 'dot-down' : 'dot-unknown';
          return '<tr>' +
            '<td data-label="Name"><a href="/website/' + w.id + '"><strong>' + esc(w.name) + '</strong></a></td>' +
            '<td data-label="URL" class="text-muted" style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(w.url) + '</td>' +
            '<td data-label="Status"><span class="dot ' + dotClass + '"></span> ' + (w.lastStatus || 'pending') + '</td>' +
            '<td data-label="Response">' + (w.lastResponseMs != null ? w.lastResponseMs + 'ms' : '-') + '</td>' +
            '<td data-label="Uptime">' + w.uptimePercent + '</td>' +
            '<td data-label="Notify"><span class="text-muted" style="font-size:12px;">' + w.notifyType + '</span></td>' +
            '<td data-label="Actions" class="flex gap-2">' +
              '<button class="btn btn-sm btn-ghost" onclick="editWebsite(\\'' + w.id + '\\')">Edit</button>' +
              '<button class="btn btn-sm btn-danger" onclick="deleteWebsite(\\'' + w.id + '\\')">Del</button>' +
            '</td>' +
          '</tr>';
        }).join('');
      }

      function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

      function toggleCustomInterval() {
        const preset = document.getElementById('f-interval-preset');
        const custom = document.getElementById('f-interval-custom');
        if (preset.value === 'custom') {
          custom.style.display = 'block';
          custom.focus();
        } else {
          custom.style.display = 'none';
        }
      }

      function toggleTemplates() {
        const arrow = document.getElementById('tpl-arrow');
        const body = document.getElementById('tpl-body');
        const header = arrow.parentElement;
        header.classList.toggle('open');
        body.classList.toggle('open');
      }

      function getIntervalValue() {
        const preset = document.getElementById('f-interval-preset').value;
        if (preset === 'custom') {
          return Math.max(10, parseInt(document.getElementById('f-interval-custom').value) || 60);
        }
        return parseInt(preset);
      }

      function setIntervalValue(seconds) {
        const preset = document.getElementById('f-interval-preset');
        const custom = document.getElementById('f-interval-custom');
        const presetValues = ['10', '30', '60', '300'];
        if (presetValues.includes(String(seconds))) {
          preset.value = String(seconds);
          custom.style.display = 'none';
        } else {
          preset.value = 'custom';
          custom.value = seconds;
          custom.style.display = 'block';
        }
      }

      function openModal() {
        document.getElementById('modal-title').textContent = 'Add Website';
        document.getElementById('edit-id').value = '';
        document.getElementById('f-name').value = '';
        document.getElementById('f-url').value = '';
        setIntervalValue(60);
        document.getElementById('f-notifyType').value = defaultSettings.defaultNotifyType || 'personal';
        document.getElementById('f-notifyTarget').value = defaultSettings.defaultNotifyTarget || '';
        document.getElementById('f-isActive').value = 'true';
        document.getElementById('f-downTemplate').value = '';
        document.getElementById('f-upTemplate').value = '';
        // Collapse templates section
        document.getElementById('tpl-arrow').parentElement.classList.remove('open');
        document.getElementById('tpl-body').classList.remove('open');
        document.getElementById('modal').classList.add('active');
      }

      function editWebsite(id) {
        const w = websites.find(x => x.id === id);
        if (!w) return;
        document.getElementById('modal-title').textContent = 'Edit Website';
        document.getElementById('edit-id').value = w.id;
        document.getElementById('f-name').value = w.name;
        document.getElementById('f-url').value = w.url;
        setIntervalValue(w.checkInterval);
        document.getElementById('f-notifyType').value = w.notifyType;
        document.getElementById('f-notifyTarget').value = w.notifyTarget;
        document.getElementById('f-isActive').value = String(w.isActive);
        document.getElementById('f-downTemplate').value = w.downTemplate || '';
        document.getElementById('f-upTemplate').value = w.upTemplate || '';
        // If templates exist, expand the section
        if (w.downTemplate || w.upTemplate) {
          document.getElementById('tpl-arrow').parentElement.classList.add('open');
          document.getElementById('tpl-body').classList.add('open');
        } else {
          document.getElementById('tpl-arrow').parentElement.classList.remove('open');
          document.getElementById('tpl-body').classList.remove('open');
        }
        document.getElementById('modal').classList.add('active');
      }

      function closeModal() { document.getElementById('modal').classList.remove('active'); }

      async function saveWebsite() {
        const id = document.getElementById('edit-id').value;
        const data = {
          name: document.getElementById('f-name').value,
          url: document.getElementById('f-url').value,
          checkInterval: getIntervalValue(),
          notifyType: document.getElementById('f-notifyType').value,
          notifyTarget: document.getElementById('f-notifyTarget').value,
          isActive: document.getElementById('f-isActive').value === 'true',
          downTemplate: document.getElementById('f-downTemplate').value || null,
          upTemplate: document.getElementById('f-upTemplate').value || null,
        };
        if (id) {
          await fetch('/api/websites/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
        } else {
          await fetch('/api/websites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
        }
        closeModal();
        load();
      }

      async function deleteWebsite(id) {
        if (!confirm('Delete this website?')) return;
        await fetch('/api/websites/' + id, { method: 'DELETE' });
        load();
      }

      loadSettings();
      load();
      setInterval(load, 15000);
    </script>`
  );
  return c.html(html);
});

// Website detail page
app.get("/website/:id", async (c) => {
  const auth = requireAuth(c);
  if (auth) return auth;

  const id = c.req.param("id");
  const website = await prisma.website.findUnique({ where: { id } });
  if (!website) return c.text("Not found", 404);

  const html = layout(
    website.name,
    `<div class="container">
      <div class="flex-between mb-4">
        <h2>${escapeHtml(website.name)}</h2>
        <a href="/dashboard" class="btn btn-ghost btn-sm">&larr; Back</a>
      </div>

      <div class="card mb-2">
        <p><strong>URL:</strong> <a href="${escapeHtml(website.url)}" target="_blank">${escapeHtml(website.url)}</a></p>
        <p><strong>Status:</strong> <span class="dot ${website.lastStatus === "up" ? "dot-up" : website.lastStatus === "down" ? "dot-down" : "dot-unknown"}"></span> ${website.lastStatus || "pending"}</p>
        <p><strong>Check Interval:</strong> ${website.checkInterval}s</p>
        <p><strong>Notify:</strong> ${website.notifyType} → ${escapeHtml(website.notifyTarget)}</p>
      </div>

      <div class="stats-grid">
        <div class="stat-card"><div class="stat-value" id="up-24h">-</div><div class="stat-label">Uptime 24h</div></div>
        <div class="stat-card"><div class="stat-value" id="up-7d">-</div><div class="stat-label">Uptime 7d</div></div>
        <div class="stat-card"><div class="stat-value" id="up-30d">-</div><div class="stat-label">Uptime 30d</div></div>
      </div>

      <div class="card">
        <h3 class="mb-2">Response Time</h3>
        <canvas id="chart" height="80"></canvas>
      </div>

      <div class="card responsive-table" style="padding:0;overflow:hidden;">
        <h3 style="padding:16px 16px 0;">Incidents</h3>
        <table>
          <thead><tr><th>Started</th><th>Resolved</th><th>Duration</th><th>Notified</th></tr></thead>
          <tbody id="incidents-table"></tbody>
        </table>
      </div>

      <div class="card responsive-table mt-4" style="padding:0;overflow:hidden;">
        <h3 style="padding:16px 16px 0;">Recent Checks</h3>
        <table>
          <thead><tr><th>Time</th><th>Status</th><th>Code</th><th>Response</th><th>Error</th></tr></thead>
          <tbody id="checks-table"></tbody>
        </table>
      </div>
    </div>

    <script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
    <script>
      const id = '${id}';
      let chart = null;

      async function load() {
        const res = await fetch('/api/websites/' + id);
        const data = await res.json();

        document.getElementById('up-24h').textContent = data.uptimes['24h'];
        document.getElementById('up-7d').textContent = data.uptimes['7d'];
        document.getElementById('up-30d').textContent = data.uptimes['30d'];

        // Chart
        const checks = data.recentChecks.slice().reverse();
        const labels = checks.map(c => new Date(c.checkedAt).toLocaleTimeString());
        const values = checks.map(c => c.responseTime);
        const colors = checks.map(c => c.status === 'up' ? '#22c55e' : '#ef4444');

        if (chart) chart.destroy();
        chart = new Chart(document.getElementById('chart'), {
          type: 'bar',
          data: {
            labels,
            datasets: [{
              label: 'Response Time (ms)',
              data: values,
              backgroundColor: colors,
              borderRadius: 2,
            }]
          },
          options: {
            responsive: true,
            plugins: { legend: { display: false } },
            scales: {
              x: { display: false },
              y: { grid: { color: '#222' }, ticks: { color: '#666' } }
            }
          }
        });

        // Incidents
        document.getElementById('incidents-table').innerHTML = data.incidents.map(i => {
          return '<tr>' +
            '<td data-label="Started">' + new Date(i.startedAt).toLocaleString() + '</td>' +
            '<td data-label="Resolved">' + (i.resolvedAt ? new Date(i.resolvedAt).toLocaleString() : '<span class="text-red">Ongoing</span>') + '</td>' +
            '<td data-label="Duration">' + (i.duration != null ? formatDur(i.duration) : '-') + '</td>' +
            '<td data-label="Notified">' + (i.downNotified ? '✓' : '') + (i.upNotified ? ' ✓' : '') + '</td>' +
          '</tr>';
        }).join('');

        // Checks
        document.getElementById('checks-table').innerHTML = data.recentChecks.slice(0, 50).map(c => {
          return '<tr>' +
            '<td data-label="Time">' + new Date(c.checkedAt).toLocaleString() + '</td>' +
            '<td data-label="Status"><span class="badge ' + (c.status === 'up' ? 'badge-up' : 'badge-down') + '">' + c.status + '</span></td>' +
            '<td data-label="Code">' + (c.statusCode || '-') + '</td>' +
            '<td data-label="Response">' + c.responseTime + 'ms</td>' +
            '<td data-label="Error" class="text-muted">' + (c.errorMessage || '') + '</td>' +
          '</tr>';
        }).join('');
      }

      function formatDur(s) {
        if (s < 60) return s + 's';
        if (s < 3600) return Math.floor(s/60) + 'm';
        return Math.floor(s/3600) + 'h ' + Math.floor((s%3600)/60) + 'm';
      }

      load();
      setInterval(load, 15000);
    </script>`
  );
  return c.html(html);
});

// Settings page
app.get("/settings", async (c) => {
  const auth = requireAuth(c);
  if (auth) return auth;

  const html = layout(
    "Settings",
    `<div class="container">
      <h2 class="mb-4">Settings</h2>

      <div class="card">
        <h3 class="mb-4">Default Notification</h3>
        <div class="form-row mb-4">
          <div class="form-group">
            <label>Default Notify Type</label>
            <select id="s-notifyType">
              <option value="personal">Personal</option>
              <option value="group">Group</option>
            </select>
          </div>
          <div class="form-group">
            <label>Default Notify Target</label>
            <input type="text" id="s-notifyTarget" placeholder="628xxxxxxxxx">
          </div>
        </div>

        <h3 class="mb-4" style="margin-top:24px;">Default Notification Templates</h3>
        <div class="form-group">
          <label>DOWN Template <span class="text-muted">(leave empty for built-in default)</span></label>
          <textarea id="s-downTemplate" rows="4" placeholder="🔴 *{name}* is DOWN&#10;URL: {url}&#10;Error: {error}&#10;Time: {time}"></textarea>
        </div>
        <div class="form-group">
          <label>UP Template <span class="text-muted">(leave empty for built-in default)</span></label>
          <textarea id="s-upTemplate" rows="4" placeholder="🟢 *{name}* is back UP&#10;URL: {url}&#10;Downtime: {downtime}&#10;Time: {time}"></textarea>
        </div>
        <div class="var-ref mb-4">
          Available variables: <code>{name}</code> <code>{url}</code> <code>{error}</code> <code>{statusCode}</code> <code>{downtime}</code> <code>{time}</code>
        </div>

        <button class="btn" onclick="saveSettings()">Save Settings</button>
        <span id="save-status" style="margin-left:12px;color:#22c55e;font-size:14px;display:none;">Saved!</span>
      </div>
    </div>

    <script>
      async function loadSettings() {
        const res = await fetch('/api/settings');
        const data = await res.json();
        document.getElementById('s-notifyType').value = data.defaultNotifyType || 'personal';
        document.getElementById('s-notifyTarget').value = data.defaultNotifyTarget || '';
        document.getElementById('s-downTemplate').value = data.defaultDownTemplate || '';
        document.getElementById('s-upTemplate').value = data.defaultUpTemplate || '';
      }

      async function saveSettings() {
        const data = {
          defaultNotifyType: document.getElementById('s-notifyType').value,
          defaultNotifyTarget: document.getElementById('s-notifyTarget').value,
          defaultDownTemplate: document.getElementById('s-downTemplate').value,
          defaultUpTemplate: document.getElementById('s-upTemplate').value,
        };
        await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });
        const status = document.getElementById('save-status');
        status.style.display = 'inline';
        setTimeout(() => { status.style.display = 'none'; }, 2000);
      }

      loadSettings();
    </script>`
  );
  return c.html(html);
});

// WhatsApp setup page
app.get("/wa", async (c) => {
  const auth = requireAuth(c);
  if (auth) return auth;

  const html = layout(
    "WhatsApp",
    `<div class="container">
      <h2 class="mb-4">WhatsApp Connection</h2>
      <div class="card" id="wa-panel">
        <div style="text-align:center;padding:40px;">
          <div class="spinner"></div>
          <p class="mt-4 text-muted">Loading...</p>
        </div>
      </div>

      <div class="card responsive-table mt-4" id="groups-panel" style="display:none;">
        <h3 class="mb-2">Joined Groups</h3>
        <p class="text-muted mb-4" style="font-size:13px;">Copy the Group JID to use as notify target for group notifications</p>
        <table>
          <thead><tr><th>Group Name</th><th>JID</th></tr></thead>
          <tbody id="groups-table"></tbody>
        </table>
      </div>
    </div>

    <script>
      async function updateWA() {
        const statusRes = await fetch('/api/wa/status');
        const status = await statusRes.json();
        const panel = document.getElementById('wa-panel');
        const groupsPanel = document.getElementById('groups-panel');

        if (status.state === 'disconnected') {
          panel.innerHTML = '<div style="text-align:center;padding:40px;">' +
            '<p style="font-size:18px;margin-bottom:20px;">WhatsApp not connected</p>' +
            '<button class="btn" onclick="connectWA()">Connect WhatsApp</button>' +
          '</div>';
          groupsPanel.style.display = 'none';

        } else if (status.state === 'qr_ready') {
          const qrRes = await fetch('/api/wa/qr');
          const qrData = await qrRes.json();
          if (qrData.qr) {
            panel.innerHTML = '<div class="qr-container">' +
              '<p style="margin-bottom:16px;">Scan this QR code with WhatsApp</p>' +
              '<img src="' + qrData.qr + '" alt="QR Code" style="max-width:300px;">' +
              '<p class="text-muted mt-4" style="font-size:13px;">QR refreshes automatically</p>' +
            '</div>';
          }
          groupsPanel.style.display = 'none';

        } else if (status.state === 'connecting') {
          panel.innerHTML = '<div style="text-align:center;padding:40px;">' +
            '<div class="spinner"></div>' +
            '<p class="mt-4">Connecting...</p>' +
          '</div>';
          groupsPanel.style.display = 'none';

        } else if (status.state === 'connected') {
          panel.innerHTML = '<div style="text-align:center;padding:40px;">' +
            '<p style="font-size:18px;margin-bottom:8px;">Connected</p>' +
            '<p class="text-muted mb-4">Phone: ' + (status.number || 'Unknown') + '</p>' +
            '<button class="btn btn-danger" onclick="disconnectWA()">Disconnect</button>' +
          '</div>';

          // Load groups
          const groupsRes = await fetch('/api/wa/groups');
          const groups = await groupsRes.json();
          if (groups.length > 0) {
            groupsPanel.style.display = 'block';
            document.getElementById('groups-table').innerHTML = groups.map(g => {
              return '<tr><td data-label="Group Name">' + esc(g.subject) + '</td><td data-label="JID"><code style="background:#111;padding:4px 8px;border-radius:4px;font-size:12px;">' + esc(g.id) + '</code></td></tr>';
            }).join('');
          }
        }
      }

      function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

      async function connectWA() {
        await fetch('/api/wa/reconnect', { method: 'POST' });
        updateWA();
      }

      async function disconnectWA() {
        if (!confirm('Disconnect WhatsApp?')) return;
        await fetch('/api/wa/disconnect', { method: 'POST' });
        updateWA();
      }

      updateWA();
      setInterval(updateWA, 3000);
    </script>`
  );
  return c.html(html);
});

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export default app;
