// Vercel Serverless Function — the "investor brain".
// It runs on Vercel's servers (never in the browser), so your secret
// Anthropic API key stays hidden. The browser sends it the report text;
// it asks Claude to critique the report as three kinds of investor and
// returns the result as structured data.

// ---- Settings you can safely change later -------------------------------
const MODEL = "claude-sonnet-5";      // swap to "claude-opus-4-8" for deeper (pricier) analysis
const MAX_OUTPUT_TOKENS = 8000;       // length of the critique Claude can produce (safe for all current models)
const MAX_INPUT_CHARS = 300000;       // ~75k tokens; protects you from runaway cost on huge reports
// -------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a panel of three seasoned professional investors reviewing a company's annual report or sustainability report. You produce a candid, evidence-based critique — the kind of frank assessment given in an investment committee, not a marketing summary. Be specific, skeptical of management spin, and always ground each point in the document itself.

You reason from three distinct lenses. For EACH lens, produce points of PRAISE and points of CRITICISM.

1. GENERALIST EQUITY INVESTOR
   A balanced institutional investor weighing growth, profitability, competitive position, capital allocation, risk, and valuation. Draws on fundamental analysis (Graham & Dodd; Penman, "Financial Statement Analysis and Security Valuation"). Assesses revenue quality, margin trends, cash generation, balance-sheet strength, and whether management's narrative matches the numbers.

2. ESG / SUSTAINABILITY CRITIC
   Scrutinizes sustainability claims for substance versus greenwashing (Lyon & Montgomery, 2015, "The Means and End of Greenwash," Organization & Environment). Checks whether targets have clear baselines, timelines, and scope; whether claims are quantified and assured; whether disclosure follows recognized frameworks (GRI, SASB, TCFD/ISSB); and flags vague, selective, or unverifiable statements.

3. ACTIVIST / SHORT-SELLER
   An adversarial lens hunting for red flags: aggressive or opaque accounting, deteriorating cash conversion, related-party dealings, weak governance, misaligned incentives, undisclosed risks, and gaps between tone and substance. Draws on behavioral cues that management may be obscuring problems (Kahneman & Tversky on framing and overconfidence).

RULES:
- Report ONLY the most material points: at most 5 items of praise and at most 5 items of criticism per lens. Prioritize significance over completeness — a few sharp, high-impact points beat many minor ones.
- Every point MUST include a short verbatim quote from the provided report text that the point responds to. Keep each quote to a single sentence, roughly 30 words maximum; if the relevant passage is longer, quote only the key clause. Quote exactly; do not paraphrase inside the quote field. If you genuinely cannot find supporting text for a point, omit that point.
- Keep each "point" to 1-2 sentences. Keep "overallSummary" to 2-3 sentences.
- Be concrete. Prefer "operating margin narrative omits the 220bp decline shown in the segment table" over generic statements.
- It is acceptable for a lens to have more criticism than praise, or vice versa. Do not force balance.
- Do not invent figures not present in the text.

Return ONLY valid JSON (no markdown, no preamble) matching exactly this shape:
{
  "overallSummary": "2-4 sentence executive summary of the investment case and the biggest tension in the report.",
  "lenses": [
    {
      "name": "Generalist Equity Investor",
      "praise": [ { "point": "string", "quote": "verbatim quote from report" } ],
      "criticism": [ { "point": "string", "quote": "verbatim quote from report" } ]
    },
    {
      "name": "ESG / Sustainability Critic",
      "praise": [ ... ],
      "criticism": [ ... ]
    },
    {
      "name": "Activist / Short-Seller",
      "praise": [ ... ],
      "criticism": [ ... ]
    }
  ]
}`;

// Tries hard to pull a valid JSON object out of the model's text.
function tryParseJson(text) {
  try { return JSON.parse(text); } catch (e) {}
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch (e) {}
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: "The ANTHROPIC_API_KEY is not set. Add it in Vercel → Project → Settings → Environment Variables, then redeploy."
    });
  }

  let text = "";
  let companyName = "";
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    text = (body && body.text) || "";
    companyName = (body && body.companyName) || "";
  } catch (e) {
    return res.status(400).json({ error: "Could not read the request. Please try again." });
  }

  if (!text || text.trim().length < 200) {
    return res.status(400).json({
      error: "The uploaded document had too little readable text. If it's a scanned PDF (images, not text), it can't be analyzed yet."
    });
  }

  let truncated = false;
  if (text.length > MAX_INPUT_CHARS) {
    text = text.slice(0, MAX_INPUT_CHARS);
    truncated = true;
  }

  const userContent =
    (companyName ? `Company: ${companyName}\n\n` : "") +
    `Here is the report text to analyze:\n\n"""\n${text}\n"""`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [
          { role: "user", content: userContent }
        ]
      })
    });

    if (!response.ok) {
      const detail = await response.text();
      return res.status(502).json({
        error: "The AI service returned an error: " + detail.slice(0, 400)
      });
    }

    const data = await response.json();
    const raw = (data.content && data.content[0] && data.content[0].text) || "";
    const stopReason = data.stop_reason;

    // Claude is instructed to return pure JSON. Strip any stray code fences,
    // then tryParseJson pulls out the {...} object even if there's stray text. // no-prefill-v3-capped
    let cleaned = raw.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();

    let parsed = tryParseJson(cleaned);
    if (!parsed) {
      // If the model ran out of room mid-answer, the JSON is unterminated.
      if (stopReason === "max_tokens") {
        return res.status(502).json({
          error: "The report is very long and the analysis was cut off. Try a shorter report, or ask to raise the output limit."
        });
      }
      return res.status(502).json({ error: "The AI response could not be parsed. Please try again." });
    }

    parsed.truncated = truncated;
    return res.status(200).json(parsed);
  } catch (err) {
    return res.status(500).json({ error: "Something went wrong contacting the AI service.", detail: String(err).slice(0, 300) });
  }
}
