// netlify/functions/league-create.js
// Creates a new shared league or fetches an existing one by room code.
// Uses Supabase as the backend store.
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

function makeCode() {
  // 4-letter room code, no ambiguous chars
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
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
    const { action, code, playerName, teamAvg } = JSON.parse(event.body || "{}");

    // ── JOIN existing league ──────────────────────────────────────
    if (action === "join") {
      if (!code || !playerName) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing code or playerName" }) };
      }

      const rows = await supabase(`friend_leagues?code=eq.${code.toUpperCase()}&select=*`);
      if (!rows || rows.length === 0) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: "League not found" }) };
      }

      const league = rows[0];
      const data = league.data;

      // Check player not already in league
      const already = data.teams.find(t => t.name === playerName);
      if (!already) {
        // Add player team to the league
        data.teams.push({
          name: playerName,
          avg: teamAvg || 65,
          isPlayer: false, // treated as "real" but not the local device's player
          isHuman: true,
          w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0,
        });

        // Regenerate fixtures for new team count
        data.fixtures = generateFixtures(data.teams);
        data.week = 1;

        await supabase(
          `friend_leagues?code=eq.${code.toUpperCase()}`,
          "PATCH",
          { data }
        );
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ league: { code, ...data } }),
      };
    }

    // ── CREATE new league ─────────────────────────────────────────
    if (action === "create") {
      if (!playerName) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing playerName" }) };
      }

      const code = makeCode();
      const teams = [
        { name: playerName, avg: teamAvg || 65, isHuman: true, isPlayer: false, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 },
      ];

      const data = {
        teams,
        fixtures: [],
        week: 1,
        season: 1,
        createdAt: new Date().toISOString(),
      };

      await supabase("friend_leagues", "POST", { code, data });

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ league: { code, ...data } }),
      };
    }

    // ── FETCH league state ────────────────────────────────────────
    if (action === "fetch") {
      if (!code) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing code" }) };
      }
      const rows = await supabase(`friend_leagues?code=eq.${code.toUpperCase()}&select=*`);
      if (!rows || rows.length === 0) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: "League not found" }) };
      }
      const league = rows[0];
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ league: { code, ...league.data } }),
      };
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
        played: false,
        result: null,
        hg: 0,
        ag: 0,
      });
    }
  }
  const perWeek = Math.ceil(fixtures.length / TOTAL_WEEKS);
  fixtures.forEach((f, i) => { f.week = Math.floor(i / perWeek) + 1; });
  return fixtures;
}
