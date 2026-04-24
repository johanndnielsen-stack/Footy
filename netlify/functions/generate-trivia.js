exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const ANTHROPIC_KEY = process.env.FC_AK;
  if (!ANTHROPIC_KEY) {
    return { statusCode: 500, body: "API key not configured" };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: "Invalid JSON" };
  }

  const { league, lang } = body;
  if (!league || !lang) {
    return { statusCode: 400, body: "Missing league or lang" };
  }

  const prompt = `Generate exactly 3 football trivia questions focused on ${league}.
One easy, one medium, one hard. Language: ${lang}.
Rules: questions must be factual and verifiable. Cover history, records, players, clubs, rules, competitions.
Respond with ONLY a JSON array, no markdown, no explanation:
[
  {"diff":"easy","q":"question text","a":"correct answer","opts":["opt1","opt2","opt3","opt4"]},
  {"diff":"medium","q":"...","a":"...","opts":[...]},
  {"diff":"hard","q":"...","a":"...","opts":[...]}
]
The correct answer must be one of the 4 opts. Opts must be shuffled (correct answer not always first).`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 600,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error("Anthropic error:", res.status, err);
      return { statusCode: res.status, body: "Trivia generation failed" };
    }

    const data = await res.json();
    const text = data.content.map((c) => c.text || "").join("").trim();
    const clean = text.replace(/```json|```/g, "").trim();
    const qs = JSON.parse(clean);

    if (!Array.isArray(qs) || qs.length !== 3) {
      throw new Error("Bad response shape from Claude");
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(qs),
    };
  } catch (err) {
    console.error("generate-trivia error:", err);
    return { statusCode: 500, body: "Internal error" };
  }
};
