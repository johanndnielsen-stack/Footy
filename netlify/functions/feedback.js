// netlify/functions/feedback.js
// Collects in-app feedback into the Supabase `feedback` table.
// Access goes through the SERVICE key (server-side only). No PII required —
// username is optional and only stored if the player is signed in.
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function supabase(path, method = "GET", body = null) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      "apikey": SUPABASE_KEY,
      "Authorization": `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": method === "POST" ? "return=minimal" : "",
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

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };

  try {
    const body = JSON.parse(event.body || "{}");
    const message = (body.message || "").toString().trim();
    if (message.length < 3) return { statusCode: 400, headers, body: JSON.stringify({ error: "Message too short" }) };

    const row = {
      message: message.slice(0, 2000),
      username: body.username ? String(body.username).slice(0, 40) : null,
      lang: body.lang ? String(body.lang).slice(0, 8) : null,
      screen: body.screen ? String(body.screen).slice(0, 40) : null,
      user_agent: (event.headers["user-agent"] || "").slice(0, 300),
    };
    await supabase("feedback", "POST", row);

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };

  } catch (err) {
    console.error(err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
