exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const HF_TOKEN = process.env.FC_HF_KEY;
  if (!HF_TOKEN) {
    return { statusCode: 500, body: "API key not configured" };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: "Invalid JSON" };
  }

  const { prompt, parameters } = body;
  if (!prompt) {
    return { statusCode: 400, body: "Missing prompt" };
  }

  try {
    const hfRes = await fetch("https://api-inference.huggingface.co/models/black-forest-labs/FLUX.1-schnell", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${HF_TOKEN}`,
        "Content-Type": "application/json",
        "Accept": "image/jpeg",
      },
      body: JSON.stringify({ inputs: prompt, parameters }),
    });

    if (!hfRes.ok) {
      const err = await hfRes.text();
      console.error("HF error:", hfRes.status, err);
      return { statusCode: hfRes.status, body: "Image generation failed" };
    }

    const arrayBuffer = await hfRes.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString("base64");

    return {
      statusCode: 200,
      headers: { "Content-Type": "image/jpeg" },
      body: base64,
      isBase64Encoded: true,
    };
  } catch (err) {
    console.error("generate-art error:", err);
    return { statusCode: 500, body: "Internal error" };
  }
};
