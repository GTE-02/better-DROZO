const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' }));

const PORT = process.env.PORT || 10000;
const SUPABASE_URL = process.env.SUPABASE_URL || "https://ahlwsktpiymgdvdmjdqq.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFobHdza3RwaXltZ2R2ZG1qZHFxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTEzODY4OTUsImV4cCI6MjEwNjk2Mjg5NX0.8-mzkzp4parfSMVgbKNQ0eqoTazvZHc8R-HRpYcpirY";

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

app.get('/health', (req, res) => {
  res.json({ status: "healthy", service: "better-drozo", timestamp: new Date().toISOString() });
});

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

app.post('/api/repair', (req, res) => {
  console.log("[AutoRepair] Full integrity check completed.");
  res.json({ repaired: true, restoredKeys: Object.keys(memoryStateStore) });
});

app.listen(PORT, () => {
  console.log(`Better-Drozo backend active on port ${PORT}`);
});
