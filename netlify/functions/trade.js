// netlify/functions/trade.js
// Card trading between two registered accounts. Trades are proposed with a
// snapshot of both cards, then settled atomically on accept: both accounts'
// `data.collection`/`data.team` are mutated server-side in one request.
//
// Sync gotcha this design has to account for: each device pushes its FULL
// local state on every change (account.js "save" is a blind overwrite, not a
// merge). So when a trade is accepted, the ACCEPTER's client applies the
// result immediately (it's already looking at the response) and its next
// autosave matches the new server state — fine. But the PROPOSER's device
// wasn't there for that request; if it pushed a save before learning about
// the trade, it would silently overwrite the trade back out. So an accepted
// trade stays in an "accepted" (not yet "done") state until the proposer's
// client polls, applies the swap locally, and calls "ack" — only then is it
// safe to consider settled.
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function supabase(path, method = "GET", body = null) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      "apikey": SUPABASE_KEY,
      "Authorization": `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": method === "POST" ? "return=representation" : (method === "PATCH" ? "return=representation" : ""),
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

async function findByUsername(username) {
  const rows = await supabase(`accounts?username_lower=eq.${encodeURIComponent(username.toLowerCase())}&select=*`);
  return rows && rows.length ? rows[0] : null;
}
async function findByToken(token) {
  const filter = encodeURIComponent(JSON.stringify([token]));
  const rows = await supabase(`accounts?tokens=cs.${filter}&select=*`);
  return rows && rows.length ? rows[0] : null;
}
async function findTrade(id) {
  const rows = await supabase(`trades?id=eq.${id}&select=*`);
  return rows && rows.length ? rows[0] : null;
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
    const token = (body.token || "").trim();
    if (!token) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing token" }) };
    const me = await findByToken(token);
    if (!me) return { statusCode: 401, headers, body: JSON.stringify({ error: "Session expired" }) };

    // ── BROWSE: look up another player's collection by username ─────
    if (action === "browse") {
      const username = (body.username || "").trim();
      if (!username) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing username" }) };
      if (username.toLowerCase() === me.username_lower) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "That's your own account." }) };
      }
      const other = await findByUsername(username);
      if (!other) return { statusCode: 404, headers, body: JSON.stringify({ error: "No player with that username." }) };
      const collection = (other.data && other.data.collection) || [];
      const team = (other.data && other.data.team) || [];
      const teamIds = new Set(team.map(c => c.id));
      // Cards in their active XI aren't offerable — mirrors the sell rule.
      const tradeable = collection.filter(c => !teamIds.has(c.id));
      return { statusCode: 200, headers, body: JSON.stringify({ username: other.username, collection: tradeable }) };
    }

    // ── PROPOSE ───────────────────────────────────────────────────
    if (action === "propose") {
      const toUsername = (body.toUsername || "").trim();
      const offerCardId = body.offerCardId;
      const requestCardId = body.requestCardId;
      if (!toUsername || offerCardId == null || requestCardId == null) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing fields" }) };
      }
      if (toUsername.toLowerCase() === me.username_lower) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "Can't trade with yourself." }) };
      }
      const other = await findByUsername(toUsername);
      if (!other) return { statusCode: 404, headers, body: JSON.stringify({ error: "No player with that username." }) };

      const myCollection = (me.data && me.data.collection) || [];
      const myTeamIds = new Set(((me.data && me.data.team) || []).map(c => c.id));
      const offerCard = myCollection.find(c => String(c.id) === String(offerCardId));
      if (!offerCard) return { statusCode: 400, headers, body: JSON.stringify({ error: "You don't own that card." }) };
      if (myTeamIds.has(offerCard.id)) return { statusCode: 400, headers, body: JSON.stringify({ error: "Remove that card from your team before trading it." }) };

      const otherCollection = (other.data && other.data.collection) || [];
      const otherTeamIds = new Set(((other.data && other.data.team) || []).map(c => c.id));
      const requestCard = otherCollection.find(c => String(c.id) === String(requestCardId));
      if (!requestCard) return { statusCode: 400, headers, body: JSON.stringify({ error: "They no longer have that card." }) };
      if (otherTeamIds.has(requestCard.id)) return { statusCode: 400, headers, body: JSON.stringify({ error: "That card is in their active team." }) };

      const rows = await supabase("trades", "POST", {
        from_username: me.username,
        to_username: other.username,
        offer_card: offerCard,
        request_card: requestCard,
        status: "pending",
      });
      return { statusCode: 200, headers, body: JSON.stringify({ trade: rows[0] }) };
    }

    // ── LIST: everything involving me ────────────────────────────
    if (action === "list") {
      const rows = await supabase(
        `trades?or=(to_username.eq.${encodeURIComponent(me.username)},from_username.eq.${encodeURIComponent(me.username)})&order=created_at.desc&limit=50`
      );
      return { statusCode: 200, headers, body: JSON.stringify({ trades: rows || [] }) };
    }

    // ── RESPOND: recipient accepts or declines ───────────────────
    if (action === "respond") {
      const tradeId = body.tradeId;
      const accept = !!body.accept;
      if (!tradeId) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing tradeId" }) };
      const trade = await findTrade(tradeId);
      if (!trade || trade.status !== "pending") return { statusCode: 400, headers, body: JSON.stringify({ error: "Trade is no longer pending." }) };
      if (trade.to_username.toLowerCase() !== me.username_lower) {
        return { statusCode: 403, headers, body: JSON.stringify({ error: "This trade isn't yours to answer." }) };
      }

      if (!accept) {
        await supabase(`trades?id=eq.${tradeId}`, "PATCH", { status: "declined", updated_at: new Date().toISOString() });
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, status: "declined" }) };
      }

      const fromAcc = await findByUsername(trade.from_username);
      if (!fromAcc) {
        await supabase(`trades?id=eq.${tradeId}`, "PATCH", { status: "failed", updated_at: new Date().toISOString() });
        return { statusCode: 409, headers, body: JSON.stringify({ error: "The other player's account no longer exists." }) };
      }
      const fromCollection = (fromAcc.data && fromAcc.data.collection) || [];
      const myCollection = (me.data && me.data.collection) || [];
      const liveOffer = fromCollection.find(c => c.id === trade.offer_card.id);
      const liveRequest = myCollection.find(c => c.id === trade.request_card.id);
      if (!liveOffer || !liveRequest) {
        await supabase(`trades?id=eq.${tradeId}`, "PATCH", { status: "failed", updated_at: new Date().toISOString() });
        return { statusCode: 409, headers, body: JSON.stringify({ error: "This trade is no longer valid — one of the cards has moved." }) };
      }

      const newFromCollection = fromCollection.filter(c => c.id !== liveOffer.id).concat([liveRequest]);
      const newFromTeam = ((fromAcc.data && fromAcc.data.team) || []).filter(c => c.id !== liveOffer.id);
      const newMyCollection = myCollection.filter(c => c.id !== liveRequest.id).concat([liveOffer]);
      const newMyTeam = ((me.data && me.data.team) || []).filter(c => c.id !== liveRequest.id);

      await supabase(`accounts?id=eq.${fromAcc.id}`, "PATCH", {
        data: { ...fromAcc.data, collection: newFromCollection, team: newFromTeam },
        updated_at: new Date().toISOString(),
      });
      await supabase(`accounts?id=eq.${me.id}`, "PATCH", {
        data: { ...me.data, collection: newMyCollection, team: newMyTeam },
        updated_at: new Date().toISOString(),
      });
      await supabase(`trades?id=eq.${tradeId}`, "PATCH", { status: "accepted", updated_at: new Date().toISOString() });

      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, status: "accepted", gained: liveOffer }) };
    }

    // ── CANCEL: proposer withdraws a still-pending trade ─────────
    if (action === "cancel") {
      const tradeId = body.tradeId;
      if (!tradeId) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing tradeId" }) };
      const trade = await findTrade(tradeId);
      if (!trade || trade.status !== "pending") return { statusCode: 400, headers, body: JSON.stringify({ error: "Trade is no longer pending." }) };
      if (trade.from_username.toLowerCase() !== me.username_lower) {
        return { statusCode: 403, headers, body: JSON.stringify({ error: "This trade isn't yours to cancel." }) };
      }
      await supabase(`trades?id=eq.${tradeId}`, "PATCH", { status: "cancelled", updated_at: new Date().toISOString() });
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    // ── ACK: proposer confirms it has applied an accepted trade locally ──
    if (action === "ack") {
      const tradeId = body.tradeId;
      if (!tradeId) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing tradeId" }) };
      const trade = await findTrade(tradeId);
      if (!trade || trade.status !== "accepted") return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
      if (trade.from_username.toLowerCase() !== me.username_lower) {
        return { statusCode: 403, headers, body: JSON.stringify({ error: "Not your trade." }) };
      }
      await supabase(`trades?id=eq.${tradeId}`, "PATCH", { status: "done", updated_at: new Date().toISOString() });
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: "Unknown action" }) };

  } catch (err) {
    console.error(err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
