// Vercel Serverless Function — the "investor brain".
// It runs on Vercel's servers (never in the browser), so your secret
// Anthropic API key stays hidden. The browser sends it the report text;
// it asks Claude to critique the report as three kinds of investor and
// returns the result as structured data.

// ---- Settings you can safely change later -------------------------------
const MODEL = "claude-sonnet-5";      // swap to "claude-opus-4-8" for deeper (pricier) analysis
const MAX_OUTPUT_TOKENS = 16000;      // length of the critique Claude can produce
const MAX_INPUT_CHARS = 300000;       // ~75k tokens; protects you from runaway cost on huge reports
// -------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a panel of three seasoned professional investors reviewing a company's annual report or sustainability report. You produce a candid, evidence-based critique — the kind of frank assessment given in an investment committee, not a marketing summary. Be specific, skeptical of management spin, and always ground each point in the document itself.

You reason from three distinct lenses. For EACH lens, produce points of PRAISE and points of CRITICISM.

1. EQUITY INVESTOR (GENERALIST)
   A balanced institutional investor weighing growth, profitability, competitive position, capital allocation, risk, and valuation. Draws on fundamental analysis (Graham & Dodd, "Security Analysis"; Penman, "Financial Statement Analysis and Security Valuation"). Assesses revenue quality, margin trends, cash generation, balance-sheet strength, returns on capital, and whether management's narrative matches the numbers.

2. ESG & STEWARDSHIP / CORPORATE-GOVERNANCE ANALYST (BUY-SIDE)
   An ownership-minded buy-side analyst who integrates ESG and governance into the investment case and thinks like a long-term steward of capital, not a box-ticker. Focus areas: board quality and independence, ownership and control structures (dual-class shares, controlling holders), executive remuneration and its alignment with long-term value creation, shareholder rights and minority protections, capital-allocation stewardship, audit quality, and succession. Assesses whether ESG disclosure is decision-useful and financially material (Khan, Serafeim & Yoon, 2016, "Corporate Sustainability: First Evidence on Materiality," The Accounting Review) rather than immaterial box-ticking, and distinguishes substantive commitments from greenwashing (Lyon & Montgomery, 2015, "The Means and End of Greenwash," Organization & Environment). Grounded in the governance-quality literature (Gompers, Ishii & Metrick, 2003, "Corporate Governance and Equity Prices"; Bebchuk, Cohen & Ferrell, 2009, "What Matters in Corporate Governance?") and active-ownership/engagement research (Dimson, Karakaş & Li, 2015, "Active Ownership," Review of Financial Studies), and references frameworks such as the ISSB/SASB, TCFD, GRI and stewardship codes (e.g. UK Stewardship Code, PRI). Checks whether targets have clear baselines, timelines, scope and assurance.

3. ACTIVIST SHORT-SELLER
   An adversarial lens hunting for red flags: aggressive or opaque accounting, deteriorating cash conversion, related-party dealings, weak governance, misaligned incentives, undisclosed liabilities or risks, and gaps between management's tone and the substance beneath it. Probes for narrative-versus-numbers inconsistencies and cues that management may be obscuring problems (Kahneman & Tversky on framing and overconfidence).

RULES:
- Report ONLY the most material points: at most 5 items of praise and at most 5 items of criticism per lens. Prioritize significance over completeness — a few sharp, high-impact points beat many minor ones.
- Every point MUST include a short verbatim quote from the provided report text that the point responds to. Keep each quote to a single sentence, roughly 30 words maximum; if the relevant passage is longer, quote only the key clause. Quote exactly; do not paraphrase inside the quote field. If you genuinely cannot find supporting text for a point, omit that point.
- Keep each "point" to 1-2 sentences. Keep "overallSummary" to 2-3 sentences.
- Be concrete. Prefer "operating margin narrative omits the 220bp decline shown in the segment table" over generic statements.
- It is acceptable for a lens to have more criticism than praise, or vice versa. Do not force balance.
- Do not invent figures not present in the text.

Provide your analysis by calling the "submit_analysis" tool. Include all three lenses in this order, using exactly these names: "Equity Investor (Generalist)", "ESG & Stewardship / Governance Analyst (Buy-Side)", "Activist Short-Seller".`;

// The tool defines the exact structure Claude must return. Because the API
// enforces this schema, the result is always well-formed data — no more
// hand-formatting that can break on tricky punctuation in quotes.
const ANALYSIS_TOOL = {
  name: "submit_analysis",
  description: "Submit the structured investor critique of the report.",
  input_schema: {
    type: "object",
    properties: {
      overallSummary: {
        type: "string",
        description: "2-3 sentence executive summary of the investment case and the biggest tension in the report."
      },
      lenses: {
        type: "array",
        description: "The three investor lenses, each with praise and criticism.",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Name of the investor lens." },
            praise: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  point: { type: "string", description: "1-2 sentence point of praise." },
                  quote: { type: "string", description: "Short verbatim quote from the report supporting this point." }
                },
                required: ["point", "quote"]
              }
            },
            criticism: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  point: { type: "string", description: "1-2 sentence point of criticism." },
                  quote: { type: "string", description: "Short verbatim quote from the report supporting this point." }
                },
                required: ["point", "quote"]
              }
            }
          },
          required: ["name", "praise", "criticism"]
        }
      }
    },
    required: ["overallSummary", "lenses"]
  }
};

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
        tools: [ANALYSIS_TOOL],
        tool_choice: { type: "tool", name: "submit_analysis" },
        messages: [
          { role: "user", content: userContent }
        ]
      })
    });

    if (!response.ok) {
      const detail = await response.text();
      return res.status(502).json({
        error: "[v5] The AI service returned an error: " + detail.slice(0, 400)
      });
    }

    const data = await response.json();
    const stopReason = data.stop_reason;

    // With structured output, Claude replies via a "tool_use" block whose
    // "input" is already a clean object matching our schema. // v6-voices
    const toolBlock = (data.content || []).find((c) => c.type === "tool_use");
    const parsed = toolBlock ? toolBlock.input : null;

    if (!parsed) {
      if (stopReason === "max_tokens") {
        return res.status(502).json({
          error: "[v5] This report is exceptionally long and the critique exceeded the limit. Try a somewhat shorter report for now."
        });
      }
      return res.status(502).json({ error: "[v5] The AI did not return a structured result. Please try again." });
    }

    parsed.truncated = truncated;
    return res.status(200).json(parsed);
  } catch (err) {
    return res.status(500).json({ error: "Something went wrong contacting the AI service.", detail: String(err).slice(0, 300) });
  }
}
