// netlify/functions/league-create.js
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

function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
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
    const { action, code, playerName, teamAvg } = body;

    // ── JOIN ──────────────────────────────────────────────────────
    if (action === "join") {
      if (!code || !playerName) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing code or playerName" }) };
      const rows = await supabase(`friend_leagues?code=eq.${code.toUpperCase()}&select=*`);
      if (!rows || rows.length === 0) return { statusCode: 404, headers, body: JSON.stringify({ error: "League not found" }) };
      const data = rows[0].data;
      if (!data.teams.find(t => t.name === playerName)) {
        data.teams.push({ name: playerName, avg: teamAvg || 65, isHuman: true, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 });
        data.fixtures = generateFixtures(data.teams);
        data.week = 1;
        await supabase(`friend_leagues?code=eq.${code.toUpperCase()}`, "PATCH", { data });
      }
      return { statusCode: 200, headers, body: JSON.stringify({ league: { code, ...data } }) };
    }

    // ── CREATE ────────────────────────────────────────────────────
    if (action === "create") {
      if (!playerName) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing playerName" }) };
      const newCode = makeCode();
      const teams = [{ name: playerName, avg: teamAvg || 65, isHuman: true, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 }];
      const data = { teams, fixtures: [], week: 1, season: 1, challenge: null, createdAt: new Date().toISOString() };
      await supabase("friend_leagues", "POST", { code: newCode, data });
      return { statusCode: 200, headers, body: JSON.stringify({ league: { code: newCode, ...data } }) };
    }

    // ── FETCH ─────────────────────────────────────────────────────
    if (action === "fetch") {
      if (!code) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing code" }) };
      const rows = await supabase(`friend_leagues?code=eq.${code.toUpperCase()}&select=*`);
      if (!rows || rows.length === 0) return { statusCode: 404, headers, body: JSON.stringify({ error: "League not found" }) };
      return { statusCode: 200, headers, body: JSON.stringify({ league: { code, ...rows[0].data } }) };
    }

    // ── CHALLENGE: challenger sends a match invite ─────────────────
    if (action === "challenge") {
      const { from, to, fixture, seed } = body;
      if (!code || !from || !to || !fixture || seed == null) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing fields" }) };
      const rows = await supabase(`friend_leagues?code=eq.${code.toUpperCase()}&select=*`);
      if (!rows || rows.length === 0) return { statusCode: 404, headers, body: JSON.stringify({ error: "League not found" }) };
      const data = rows[0].data;
      data.challenge = { from, to, fixture, seed, status: "pending", ts: Date.now() };
      await supabase(`friend_leagues?code=eq.${code.toUpperCase()}`, "PATCH", { data });
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, league: { code, ...data } }) };
    }

    // ── ACCEPT-CHALLENGE: opponent confirms, both sides can simulate
    if (action === "accept-challenge") {
      const { by } = body;
      if (!code || !by) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing fields" }) };
      const rows = await supabase(`friend_leagues?code=eq.${code.toUpperCase()}&select=*`);
      if (!rows || rows.length === 0) return { statusCode: 404, headers, body: JSON.stringify({ error: "League not found" }) };
      const data = rows[0].data;
      if (!data.challenge || data.challenge.to !== by) return { statusCode: 400, headers, body: JSON.stringify({ error: "No pending challenge for you" }) };
      data.challenge.status = "accepted";
      await supabase(`friend_leagues?code=eq.${code.toUpperCase()}`, "PATCH", { data });
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, league: { code, ...data } }) };
    }

    // ── CANCEL-CHALLENGE: challenger withdraws ────────────────────
    if (action === "cancel-challenge") {
      if (!code) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing code" }) };
      const rows = await supabase(`friend_leagues?code=eq.${code.toUpperCase()}&select=*`);
      if (!rows || rows.length === 0) return { statusCode: 404, headers, body: JSON.stringify({ error: "League not found" }) };
      const data = rows[0].data;
      data.challenge = null;
      await supabase(`friend_leagues?code=eq.${code.toUpperCase()}`, "PATCH", { data });
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, league: { code, ...data } }) };
    }

    // ── NEW-SEASON: any player can trigger; regenerates fixtures, bumps season ──
    if (action === "new-season") {
      if (!code) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing code" }) };
      const rows = await supabase(`friend_leagues?code=eq.${code.toUpperCase()}&select=*`);
      if (!rows || rows.length === 0) return { statusCode: 404, headers, body: JSON.stringify({ error: "League not found" }) };
      const data = rows[0].data;
      // Reset all team stats
      data.teams.forEach(t => { t.w = 0; t.d = 0; t.l = 0; t.gf = 0; t.ga = 0; t.pts = 0; });
      // Regenerate fixtures
      data.fixtures = generateFixtures(data.teams);
      data.week = 1;
      data.season = (data.season || 1) + 1;
      data.challenge = null;
      await supabase(`friend_leagues?code=eq.${code.toUpperCase()}`, "PATCH", { data });
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, league: { code, ...data } }) };
    }

    // ── STATUS: lightweight poll endpoint (challenge + standings hash only) ──
    if (action === "status") {
      if (!code) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing code" }) };
      const rows = await supabase(`friend_leagues?code=eq.${code.toUpperCase()}&select=*`);
      if (!rows || rows.length === 0) return { statusCode: 404, headers, body: JSON.stringify({ error: "League not found" }) };
      const data = rows[0].data;
      // Return only what the idle poll needs: challenge state + standings + week
      return { statusCode: 200, headers, body: JSON.stringify({ status: { challenge: data.challenge || null, teams: data.teams, week: data.week } }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: "Unknown action" }) };

  } catch (err) {
    console.error(err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};

function generateFixtures(teams) {
  const fixtures = [];
  const TOTAL_WEEKS = 10;
  for (let i = 0; i < teams.length; i++) {
    for (let j = i + 1; j < teams.length; j++) {
      fixtures.push({
        home: teams[i].name,
        away: teams[j].name,
        homeIsHuman: teams[i].isHuman,
        awayIsHuman: teams[j].isHuman,
        played: false, result: null, hg: 0, ag: 0,
      });
    }
  }
  const perWeek = Math.ceil(fixtures.length / TOTAL_WEEKS);
  fixtures.forEach((f, i) => { f.week = Math.floor(i / perWeek) + 1; });
  return fixtures;
}
