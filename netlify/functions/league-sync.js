// netlify/functions/league-sync.js
// Posts a match result (or bot-vs-bot week sim) back to the shared league.
// Env vars needed: SUPABASE_URL, SUPABASE_SERVICE_KEY

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

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  try {
    const { code, playerName, homeTeam, awayTeam, hg, ag } = JSON.parse(event.body || "{}");

    if (!code || !homeTeam || !awayTeam || hg == null || ag == null) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing fields" }) };
    }

    // Fetch current league state
    const rows = await supabase(`friend_leagues?code=eq.${code.toUpperCase()}&select=*`);
    if (!rows || rows.length === 0) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: "League not found" }) };
    }

    const league = rows[0];
    const data = league.data;

    // Find the matching fixture and mark it played
    const fix = data.fixtures.find(
      f => !f.played &&
        ((f.home === homeTeam && f.away === awayTeam) ||
         (f.home === awayTeam && f.away === homeTeam))
    );

    if (!fix) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: "Fixture not found or already played" }) };
    }

    // Normalise direction
    if (fix.home === homeTeam) {
      fix.hg = hg;
      fix.ag = ag;
    } else {
      fix.hg = ag; // was away in our call
      fix.ag = hg;
    }
    fix.played = true;
    fix.result = fix.hg > fix.ag ? "home" : fix.hg === fix.ag ? "draw" : "away";

    // Advance week if all fixtures for current week are done
    const weekFixtures = data.fixtures.filter(f => f.week === data.week);
    const allPlayed = weekFixtures.every(f => f.played);
    if (allPlayed) {
      data.week = Math.min(data.week + 1, 11);
    }

    // Write updated state back
    await supabase(
      `friend_leagues?code=eq.${code.toUpperCase()}`,
      "PATCH",
      { data }
    );

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, league: { code, ...data } }),
    };

  } catch (err) {
    console.error(err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
