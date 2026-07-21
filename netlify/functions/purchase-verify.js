// netlify/functions/purchase-verify.js
// Verifies a Stripe Checkout session (from a Payment Link redirect) and
// records it in the Supabase `purchases` table. The client grants the
// Founder Pack only after this returns ok.
//
// Env vars (Netlify → Site configuration → Environment variables):
//   STRIPE_SECRET_KEY  — sk_test_… while testing, sk_live_… when live
//   SUPABASE_URL / SUPABASE_SERVICE_KEY — already set for the other functions
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;

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
    if (!STRIPE_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: "STRIPE_SECRET_KEY not configured" }) };

    const body = JSON.parse(event.body || "{}");
    const session = (body.session || "").trim();
    if (!/^cs_[A-Za-z0-9_]+$/.test(session)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Bad session id" }) };
    }

    // Already redeemed? Idempotent success so a re-visit can't double-grant
    // (the client also guards, but the record is the source of truth).
    const existing = await supabase(`purchases?id=eq.${encodeURIComponent(session)}&select=id`);
    if (existing && existing.length) {
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, already: true }) };
    }

    // Ask Stripe whether this checkout session was actually paid.
    const res = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(session)}`, {
      headers: { "Authorization": `Bearer ${STRIPE_KEY}` },
    });
    const cs = await res.json();
    if (!res.ok) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: cs.error?.message || "Session not found" }) };
    }
    if (cs.payment_status !== "paid") {
      return { statusCode: 402, headers, body: JSON.stringify({ error: "Not paid" }) };
    }

    await supabase("purchases", "POST", {
      id: session,
      username: body.username ? String(body.username).slice(0, 40) : (cs.client_reference_id || null),
      amount_total: cs.amount_total ?? null,
      currency: cs.currency || null,
      livemode: !!cs.livemode,
    });

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };

  } catch (err) {
    console.error(err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
