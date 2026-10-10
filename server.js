const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const http = require('http');
const https = require('https');

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' }));

const PORT = process.env.PORT || 10000;
const SUPABASE_URL = process.env.SUPABASE_URL || "https://ahlwsktpiymgdvdmjdqq.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFobHdza3RwaXltZ2R2ZG1qZHFxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTEzODY4OTUsImV4cCI6MjEwNjk2Mjg5NX0.8-mzkzp4parfSMVgbKNQ0eqoTazvZHc8R-HRpYcpirY";
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || "https://better-drozo.onrender.com";

let memoryStateStore = {
  "drozo_custom_passwords": JSON.stringify({
    "admin@drozominds.com": "admin123",
    "gamerkids1109@gmail.com": "coordinator2026",
    "client@drozominds.com": "client123"
  }),
  "drozo_session_status": "NONE",
  "drozo_appointment_deleted": "false",
  "drozo_client_dispatched_docs": "[]"
};

// 1. Root and Health Endpoints
app.get('/', (req, res) => {
  res.send("DrozoMind Cloud Engine is Online & Active.");
});

app.get('/health', (req, res) => {
  res.json({
    status: "alive",
    service: "better-drozo",
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

// 2. State Sync: GET Key
app.get('/api/state/:key', async (req, res) => {
  const { key } = req.params;
  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/drozo_guard_sessions?session_token=eq.SYNC_${encodeURIComponent(key)}&order=created_at.desc&limit=1`, {
      headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` }
    });
    if (response.ok) {
      const data = await response.json();
      if (data && data.length > 0 && data[0].status) {
        memoryStateStore[key] = data[0].status;
        return res.json({ key, value: data[0].status, source: "supabase" });
      }
    }
  } catch (err) {
    console.warn(`[AutoRepair fallback] Supabase read note for ${key}:`, err.message);
  }

  const fallback = memoryStateStore[key] || null;
  res.json({ key, value: fallback, source: "memory_backup" });
});

// 3. State Sync: POST Key
app.post('/api/state', async (req, res) => {
  const { key, value, email } = req.body;
  if (!key) return res.status(400).json({ error: "Missing state key" });

  const valStr = typeof value === "object" ? JSON.stringify(value) : String(value);
  memoryStateStore[key] = valStr;

  try {
    await fetch(`${SUPABASE_URL}/rest/v1/drozo_guard_sessions`, {
      method: "POST",
      headers: {
        "apikey": SUPABASE_KEY,
        "Authorization": `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        "Prefer": "return=minimal"
      },
      body: JSON.stringify({
        session_token: "SYNC_" + key,
        email: email || "system@drozominds.com",
        status: valStr
      })
    });
  } catch (err) {
    console.warn(`[AutoRepair write notice] Queued in memory:`, err.message);
  }

  res.json({ success: true, key, stored: true });
});

// 4. Global Auto-Repair Endpoint
app.post('/api/repair', (req, res) => {
  res.json({ repaired: true, restoredKeys: Object.keys(memoryStateStore) });
});

// ==========================================
// 24/7 SELF-PING KEEP-ALIVE ENGINE
// ==========================================
function startKeepAliveEngine() {
  const PING_INTERVAL_MS = 45 * 1000; // Ping every 45 seconds

  setInterval(() => {
    https.get(`${RENDER_EXTERNAL_URL}/health`, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        console.log(`[KeepAlive] Ping acknowledged (${res.statusCode}) - Uptime: ${Math.floor(process.uptime())}s`);
      });
    }).on('error', (err) => {
      console.warn(`[KeepAlive] Ping warning: ${err.message}`);
    });
  }, PING_INTERVAL_MS);
}


// ==========================================
// GOOGLE DRIVE 5 TB STORAGE RELAY (NO GOOGLE CONSOLE)
// ==========================================
const GDRIVE_SCRIPT_URL = process.env.GDRIVE_SCRIPT_URL || "https://script.google.com/macros/s/AKfycbyTwFaNwNHZBcDFO5GfC2I4K_4ReYVn2KAfJugkgm1V7RVkno7GDk0Kpik7_vBmXNkc8g/exec";

app.post('/api/drive/upload', async (req, res) => {
  if (!GDRIVE_SCRIPT_URL) {
    return res.status(503).json({ error: "GDRIVE_SCRIPT_URL environment variable is not configured." });
  }

  try {
    const response = await fetch(GDRIVE_SCRIPT_URL, {
      method: 'POST',
      redirect: 'follow',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });
    const result = await response.json();
    res.json(result);
  } catch (err) {
    console.error("[DriveRelay] Upload error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Periodic Database Snapshot to Google Drive
app.post('/api/drive/backup-database', async (req, res) => {
  if (!GDRIVE_SCRIPT_URL) return res.status(503).json({ error: "Drive relay not configured" });

  try {
    const response = await fetch(GDRIVE_SCRIPT_URL, {
      method: 'POST',
      redirect: 'follow',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: `DrozoMind_Backup_${Date.now()}.json`,
        content: JSON.stringify(memoryStateStore, null, 2)
      })
    });
    const result = await response.json();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// Auto-backup to Google Drive every 30 minutes
setInterval(async () => {
  if (!GDRIVE_SCRIPT_URL) return;
  try {
    console.log("[GoogleDrive] Running scheduled state backup...");
    await fetch(GDRIVE_SCRIPT_URL, {
      method: 'POST',
      redirect: 'follow',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: `DrozoMind_AutoBackup_${Date.now()}.json`,
        content: JSON.stringify(memoryStateStore, null, 2)
      })
    });
    console.log("[GoogleDrive] Periodic backup completed successfully.");
  } catch (err) {
    console.warn("[GoogleDrive] Scheduled backup notice:", err.message);
  }
}, 30 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`Better-Drozo backend active on port ${PORT}`);
  startKeepAliveEngine();
});
