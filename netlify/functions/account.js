// netlify/functions/account.js
// Username + PIN accounts with device auto-login tokens.
// All access goes through the Supabase SERVICE key (server-side only).
const crypto = require("crypto");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function supabase(path, method = "GET", body = null) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      "apikey": SUPABASE_KEY,
      "Authorization": `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": method === "POST" ? "return=representation" : "",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase ${method} ${path} → ${res.status}: ${err}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ── PIN hashing (scrypt) ──────────────────────────────────────
function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(pin), salt, 32).toString("hex");
  return `${salt}$${hash}`;
}
function verifyPin(pin, stored) {
  if (!stored || !stored.includes("$")) return false;
  const [salt, hash] = stored.split("$");
  const test = crypto.scryptSync(String(pin), salt, 32).toString("hex");
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(test, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function newToken() {
  return crypto.randomBytes(24).toString("hex");
}

const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
const PIN_RE = /^[0-9]{4,8}$/;

async function findByUsername(username) {
  const rows = await supabase(`accounts?username_lower=eq.${encodeURIComponent(username.toLowerCase())}&select=*`);
  return rows && rows.length ? rows[0] : null;
}
async function findByToken(token) {
  const filter = encodeURIComponent(JSON.stringify([token]));
  const rows = await supabase(`accounts?tokens=cs.${filter}&select=*`);
  return rows && rows.length ? rows[0] : null;
}

// Keep the most recent N device tokens so the array can't grow forever.
function pushToken(tokens, token, max = 10) {
  const list = Array.isArray(tokens) ? tokens.filter(tk => tk !== token) : [];
  list.push(token);
  return list.slice(-max);
}

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };

  try {
    const body = JSON.parse(event.body || "{}");
    const action = body.action;

    // ── REGISTER ────────────────────────────────────────────────
    if (action === "register") {
      const username = (body.username || "").trim();
      const pin = (body.pin || "").trim();
      if (!USERNAME_RE.test(username)) return { statusCode: 400, headers, body: JSON.stringify({ error: "Username must be 3–20 letters, numbers or underscores." }) };
      if (!PIN_RE.test(pin)) return { statusCode: 400, headers, body: JSON.stringify({ error: "PIN must be 4–8 digits." }) };

      const existing = await findByUsername(username);
      if (existing) return { statusCode: 409, headers, body: JSON.stringify({ error: "That username is taken." }) };

      const token = newToken();
      const data = (body.data && typeof body.data === "object") ? body.data : {};
      const row = {
        username,
        username_lower: username.toLowerCase(),
        pin_hash: hashPin(pin),
        tokens: [token],
        data,
      };
      await supabase("accounts", "POST", row);
      return { statusCode: 200, headers, body: JSON.stringify({ token, username, data }) };
    }

    // ── LOGIN ───────────────────────────────────────────────────
    if (action === "login") {
      const username = (body.username || "").trim();
      const pin = (body.pin || "").trim();
      if (!username || !pin) return { statusCode: 400, headers, body: JSON.stringify({ error: "Enter your username and PIN." }) };

      const acc = await findByUsername(username);
      if (!acc || !verifyPin(pin, acc.pin_hash)) {
        return { statusCode: 401, headers, body: JSON.stringify({ error: "Wrong username or PIN." }) };
      }
      const token = newToken();
      const tokens = pushToken(acc.tokens, token);
      await supabase(`accounts?id=eq.${acc.id}`, "PATCH", { tokens });
      return { statusCode: 200, headers, body: JSON.stringify({ token, username: acc.username, data: acc.data || {} }) };
    }

    // ── AUTO-LOGIN (known device) ───────────────────────────────
    if (action === "auto") {
      const token = (body.token || "").trim();
      if (!token) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing token" }) };
      const acc = await findByToken(token);
      if (!acc) return { statusCode: 401, headers, body: JSON.stringify({ error: "Session expired" }) };
      return { statusCode: 200, headers, body: JSON.stringify({ token, username: acc.username, data: acc.data || {} }) };
    }

    // ── SAVE (push progress) ────────────────────────────────────
    if (action === "save") {
      const token = (body.token || "").trim();
      if (!token) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing token" }) };
      const acc = await findByToken(token);
      if (!acc) return { statusCode: 401, headers, body: JSON.stringify({ error: "Session expired" }) };
      const data = (body.data && typeof body.data === "object") ? body.data : {};
      await supabase(`accounts?id=eq.${acc.id}`, "PATCH", { data, updated_at: new Date().toISOString() });
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    // ── LOGOUT (forget this device) ─────────────────────────────
    if (action === "logout") {
      const token = (body.token || "").trim();
      if (!token) return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
      const acc = await findByToken(token);
      if (acc) {
        const tokens = (acc.tokens || []).filter(tk => tk !== token);
        await supabase(`accounts?id=eq.${acc.id}`, "PATCH", { tokens });
      }
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    // ── DELETE ACCOUNT (data-deletion / GDPR) ───────────────────
    if (action === "delete") {
      const token = (body.token || "").trim();
      const pin = (body.pin || "").trim();
      if (!token) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing token" }) };
      const acc = await findByToken(token);
      if (!acc) return { statusCode: 401, headers, body: JSON.stringify({ error: "Session expired" }) };
      if (!verifyPin(pin, acc.pin_hash)) return { statusCode: 401, headers, body: JSON.stringify({ error: "Wrong PIN." }) };
      await supabase(`accounts?id=eq.${acc.id}`, "DELETE");
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: "Unknown action" }) };

  } catch (err) {
    console.error(err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
