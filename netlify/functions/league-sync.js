// netlify/functions/league-sync.js
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

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };

  try {
    const body = JSON.parse(event.body || "{}");
    // Accept home/away (client) or homeTeam/awayTeam (legacy)
    const { code, hg, ag } = body;
    const homeTeam = body.home || body.homeTeam;
    const awayTeam = body.away || body.awayTeam;

    if (!code || !homeTeam || !awayTeam || hg == null || ag == null) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing fields" }) };
    }

    const rows = await supabase(`friend_leagues?code=eq.${code.toUpperCase()}&select=*`);
    if (!rows || rows.length === 0) return { statusCode: 404, headers, body: JSON.stringify({ error: "League not found" }) };

    const data = rows[0].data;

    // Find fixture (unplayed, either direction)
    const fix = data.fixtures.find(f =>
      !f.played &&
      ((f.home === homeTeam && f.away === awayTeam) ||
       (f.home === awayTeam && f.away === homeTeam))
    );

    if (!fix) return { statusCode: 404, headers, body: JSON.stringify({ error: "Fixture not found or already played" }) };

    // Normalise scores so fix.hg/ag always refer to fix.home/fix.away
    if (fix.home === homeTeam) {
      fix.hg = hg; fix.ag = ag;
    } else {
      fix.hg = ag; fix.ag = hg;
    }
    fix.played = true;
    fix.result = fix.hg > fix.ag ? "home" : fix.hg === fix.ag ? "draw" : "away";

    // Clear challenge now that the match is recorded
    data.challenge = null;

    // Recalculate standings from scratch across all played fixtures
    if (data.teams) {
      data.teams.forEach(t => { t.w = 0; t.d = 0; t.l = 0; t.gf = 0; t.ga = 0; t.pts = 0; });
      data.fixtures.filter(f => f.played).forEach(f => {
        const home = data.teams.find(t => t.name === f.home);
        const away = data.teams.find(t => t.name === f.away);
        if (home) { home.gf += f.hg; home.ga += f.ag; }
        if (away) { away.gf += f.ag; away.ga += f.hg; }
        if (f.result === "home") {
          if (home) { home.w++; home.pts += 3; }
          if (away) away.l++;
        } else if (f.result === "draw") {
          if (home) { home.d++; home.pts += 1; }
          if (away) { away.d++; away.pts += 1; }
        } else {
          if (away) { away.w++; away.pts += 3; }
          if (home) home.l++;
        }
      });
    }

    // Advance week if all fixtures for current week are now played
    const weekFixtures = data.fixtures.filter(f => f.week === data.week);
    if (weekFixtures.every(f => f.played)) {
      data.week = Math.min(data.week + 1, 11);
    }

    await supabase(`friend_leagues?code=eq.${code.toUpperCase()}`, "PATCH", { data });

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, league: { code, ...data } }) };

  } catch (err) {
    console.error(err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
