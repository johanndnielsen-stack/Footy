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
    // hf-inference dropped FLUX.1-schnell (HTTP 410), so this now goes through
    // the HF router to the `together` provider, which still serves it. Billing
    // stays on the same HF token. Together uses an OpenAI-style images API:
    // `steps` instead of `num_inference_steps`, base64 JSON response.
    const hfRes = await fetch("https://router.huggingface.co/together/v1/images/generations", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${HF_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "black-forest-labs/FLUX.1-schnell",
        prompt,
        response_format: "base64",
        steps: parameters?.num_inference_steps ?? 4,
        width: parameters?.width ?? 512,
        height: parameters?.height ?? 768,
      }),
    });

    if (!hfRes.ok) {
      const err = await hfRes.text();
      console.error("HF error:", hfRes.status, err);
      return { statusCode: hfRes.status, body: "Image generation failed" };
    }

    const json = await hfRes.json();
    const base64 = json.data?.[0]?.b64_json;
    if (!base64) {
      console.error("HF error: no image in response", JSON.stringify(json).slice(0, 300));
      return { statusCode: 502, body: "No image returned" };
    }

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
