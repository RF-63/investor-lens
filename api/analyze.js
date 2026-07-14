// Vercel Serverless Function — the "stakeholder brain".
// Runs on Vercel's servers (never in the browser), so the secret Anthropic API
// key stays hidden. The browser sends the report text plus which stakeholder
// lenses to apply; this asks Claude to critique the report through each of
// those voices and returns structured results.
//
// GET  /api/analyze  -> returns the list of available lenses (for the picker)
// POST /api/analyze  -> { text, companyName, lensIds[] } -> the critique
//
// TO ADD A NEW STAKEHOLDER LENS: add one entry to the LENSES array below.
// Nothing else needs to change — the picker and the prompt build themselves.

// ---- Settings you can safely change later -------------------------------
const MODEL = "claude-sonnet-5";      // swap to "claude-opus-4-8" for deeper (pricier) analysis
const MAX_OUTPUT_TOKENS = 16000;      // length of the critique Claude can produce
const MAX_INPUT_CHARS = 300000;       // protects you from runaway cost on huge reports
// -------------------------------------------------------------------------

const LENSES = [
  {
    id: "equity-generalist",
    name: "Equity Investor (Generalist)",
    blurb: "Fundamentals, valuation, capital allocation",
    persona: `A balanced institutional equity investor weighing growth, profitability, competitive position, capital allocation, risk, and valuation. Draws on fundamental analysis (Graham & Dodd, "Security Analysis"; Penman, "Financial Statement Analysis and Security Valuation"). Assesses revenue quality, margin trends, cash generation, balance-sheet strength, returns on capital, and whether management's narrative matches the numbers.`
  },
  {
    id: "esg-stewardship",
    name: "ESG & Stewardship / Governance Analyst (Buy-Side)",
    blurb: "Board quality, pay, shareholder rights, material ESG",
    persona: `An ownership-minded buy-side analyst who integrates ESG and governance into the investment case and thinks like a long-term steward of capital, not a box-ticker. Focus areas: board quality and independence, ownership and control structures (dual-class shares, controlling holders), executive remuneration and its alignment with long-term value creation, shareholder rights and minority protections, capital-allocation stewardship, audit quality, and succession. Assesses whether ESG disclosure is decision-useful and financially material (Khan, Serafeim & Yoon, 2016, "Corporate Sustainability: First Evidence on Materiality," The Accounting Review) rather than immaterial box-ticking, and distinguishes substantive commitments from greenwashing (Lyon & Montgomery, 2015, "The Means and End of Greenwash," Organization & Environment). Grounded in the governance-quality literature (Gompers, Ishii & Metrick, 2003, "Corporate Governance and Equity Prices"; Bebchuk, Cohen & Ferrell, 2009, "What Matters in Corporate Governance?") and active-ownership research (Dimson, Karakaş & Li, 2015, "Active Ownership," Review of Financial Studies). References ISSB/SASB, TCFD, GRI and stewardship codes. Checks whether targets have clear baselines, timelines, scope and assurance.`
  },
  {
    id: "activist-short",
    name: "Activist Short-Seller",
    blurb: "Red flags, accounting quality, narrative vs numbers",
    persona: `An adversarial lens hunting for red flags: aggressive or opaque accounting, deteriorating cash conversion, related-party dealings, weak governance, misaligned incentives, undisclosed liabilities or risks, and gaps between management's tone and the substance beneath it. Probes for narrative-versus-numbers inconsistencies and cues that management may be obscuring problems (Kahneman & Tversky on framing and overconfidence).`
  },
  {
    id: "nature",
    name: "Nature & Environment (Silent Stakeholder)",
    blurb: "Ecological limits, biodiversity, impacts and dependencies",
    persona: `The voice of the natural environment itself — a stakeholder with a genuine stake but no ability to speak (Driscoll & Starik, 2004, "The Primordial Stakeholder: Advancing the Conceptual Consideration of Stakeholder Status for the Natural Environment," Journal of Business Ethics). Judges the company against ecological limits rather than peer benchmarks or reputational optics. Assesses the company's impacts AND dependencies on nature: greenhouse gas emissions (including Scope 3), biodiversity and habitat loss, land-use change, freshwater use and pollution, resource extraction, waste and circularity. Asks whether targets are absolute rather than intensity-based, science-based, and consistent with a safe operating space for humanity (Rockström et al., 2009, "A Safe Operating Space for Humanity," Nature; Steffen et al., 2015, Science), whether the company recognises its dependence on ecosystem services and natural capital (Costanza et al., 1997, Nature; Dasgupta, 2021, "The Economics of Biodiversity: The Dasgupta Review"), and whether nature-related risks are disclosed in line with TNFD and SBTN guidance. Is sharply sceptical of offsetting used in place of absolute reduction, of intensity metrics that mask absolute growth, and of externalities the company benefits from but never books.`
  },
  {
    id: "ngo",
    name: "NGO / Civil Society Campaigner",
    blurb: "Human rights, value-chain harms, lobbying, greenwashing",
    persona: `A seasoned campaigner from an environmental and human-rights NGO, reading the report adversarially and on behalf of affected people. Scrutinises human-rights due diligence against the UN Guiding Principles on Business and Human Rights (Ruggie, 2011) and emerging due-diligence law (e.g. CSDDD): forced and child labour in the supply chain, living wages, worker safety in supplier factories, land rights and free prior informed consent of affected communities, indigenous rights, pollution and health impacts on frontline communities. Also examines corporate political influence — lobbying, trade-association memberships, and political donations — and whether they contradict the company's stated commitments; tax transparency; and remedy and grievance mechanisms for those harmed. Highly attuned to greenwashing and selective disclosure (Lyon & Montgomery, 2015, "The Means and End of Greenwash," Organization & Environment) and to the gap between policy commitments and evidence of implementation (Den Hond & de Bakker, 2007, "Ideologically Motivated Activism," Academy of Management Review). Insists on evidence, not intention.`
  },
  {
    id: "labour",
    name: "Employees & Organised Labour",
    blurb: "Safety, pay, restructuring, culture, workforce disclosure",
    persona: `A works-council member or trade-union analyst reading the report on behalf of the workforce. Focus areas: health and safety (injury and fatality rates, and whether contractors are included), pay — including living wages, the gender pay gap, and the CEO-to-median-worker pay ratio — job security, restructuring and redundancies, use of precarious, temporary and outsourced labour, collective bargaining coverage and freedom of association (ILO core conventions), training and skills investment, turnover and engagement, whistleblowing channels, and workplace culture and discrimination. Notes where workforce disclosure is thin, selective, or reported only as inputs (e.g. training hours) rather than outcomes. Grounded in the evidence that workforce quality is financially material and often under-priced by markets (Edmans, 2011, "Does the stock market fully value intangibles? Employee satisfaction and equity prices," Journal of Financial Economics) and in the industrial-relations literature (Freeman & Medoff, 1984, "What Do Unions Do?"). Sceptical of upbeat culture language that sits alongside layoffs, wage restraint, or rising executive pay.`
  }
];

function lensById(id) {
  return LENSES.find((l) => l.id === id);
}

function buildSystemPrompt(selected) {
  const lensBlocks = selected
    .map((lens, i) => `${i + 1}. ${lens.name.toUpperCase()}\n   ${lens.persona}`)
    .join("\n\n");

  const names = selected.map((l) => `"${l.name}"`).join(", ");

  return `You are a panel of stakeholder voices reviewing a company's annual report or sustainability report. Each voice produces a candid, evidence-based critique — the kind of frank assessment given behind closed doors, not a marketing summary. Be specific, sceptical of management spin, and always ground each point in the document itself.

You reason from the following distinct lenses. For EACH lens, produce points of PRAISE and points of CRITICISM, strictly from that stakeholder's point of view and priorities. Do not blur the voices together: what an investor praises, a campaigner may well criticise, and that tension is the point.

${lensBlocks}

RULES:
- Report ONLY the most material points: at most 5 items of praise and at most 5 items of criticism per lens. Prioritize significance over completeness — a few sharp, high-impact points beat many minor ones.
- Every point MUST include a short verbatim quote from the provided report text that the point responds to. Keep each quote to a single sentence, roughly 30 words maximum; if the relevant passage is longer, quote only the key clause. Quote exactly; do not paraphrase inside the quote field. If you genuinely cannot find supporting text for a point, omit that point.
- Keep each "point" to 1-2 sentences. Keep "overallSummary" to 2-3 sentences, and make it note the sharpest tension BETWEEN the stakeholder voices where one exists.
- Be concrete. Prefer "operating margin narrative omits the 220bp decline shown in the segment table" over generic statements.
- It is acceptable for a lens to have more criticism than praise, or vice versa. Do not force balance.
- Silence in the report is itself findable: absence of a disclosure a stakeholder would expect is a legitimate criticism, as long as you quote the passage where it should have appeared or where a weaker claim was made instead.
- Do not invent figures not present in the text.

Provide your analysis by calling the "submit_analysis" tool. Include all ${selected.length} lenses in this order, using exactly these names: ${names}.`;
}

// The tool defines the exact structure Claude must return. Because the API
// enforces this schema, the result is always well-formed data. // v8-lenses
const ANALYSIS_TOOL = {
  name: "submit_analysis",
  description: "Submit the structured stakeholder critique of the report.",
  input_schema: {
    type: "object",
    properties: {
      overallSummary: {
        type: "string",
        description: "2-3 sentence executive summary, noting the sharpest tension between the stakeholder voices."
      },
      lenses: {
        type: "array",
        description: "The stakeholder lenses, each with praise and criticism.",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Name of the stakeholder lens." },
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

// Accepts whatever shape the model used for "lenses" (a list, or an object
// keyed by lens name) and always returns a clean list of well-formed lenses.
function normalizeLenses(lenses) {
  let list = [];
  if (Array.isArray(lenses)) {
    list = lenses;
  } else if (lenses && typeof lenses === "object") {
    list = Object.keys(lenses).map((key) => {
      const value = lenses[key] || {};
      return { name: value.name || key, praise: value.praise, criticism: value.criticism };
    });
  }
  return list
    .filter((lens) => lens && typeof lens === "object")
    .map((lens) => ({
      name: typeof lens.name === "string" && lens.name ? lens.name : "Stakeholder",
      praise: Array.isArray(lens.praise) ? lens.praise : [],
      criticism: Array.isArray(lens.criticism) ? lens.criticism : []
    }));
}

export default async function handler(req, res) {
  // The page asks for the lens list on load, to build the picker.
  if (req.method === "GET") {
    return res.status(200).json({
      lenses: LENSES.map((l) => ({ id: l.id, name: l.name, blurb: l.blurb }))
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed." });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: "The ANTHROPIC_API_KEY is not set. Add it in Vercel → Project → Settings → Environment Variables, then redeploy."
    });
  }

  let text = "";
  let companyName = "";
  let lensIds = [];
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    text = (body && body.text) || "";
    companyName = (body && body.companyName) || "";
    lensIds = (body && Array.isArray(body.lensIds)) ? body.lensIds : [];
  } catch (e) {
    return res.status(400).json({ error: "Could not read the request. Please try again." });
  }

  if (!text || text.trim().length < 200) {
    return res.status(400).json({
      error: "The uploaded document had too little readable text. If it's a scanned PDF (images, not text), it can't be analyzed yet."
    });
  }

  // Resolve the chosen lenses; fall back to the three investor voices.
  let selected = lensIds.map(lensById).filter(Boolean);
  if (!selected.length) {
    selected = [lensById("equity-generalist"), lensById("esg-stewardship"), lensById("activist-short")];
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
        system: buildSystemPrompt(selected),
        tools: [ANALYSIS_TOOL],
        tool_choice: { type: "tool", name: "submit_analysis" },
        messages: [{ role: "user", content: userContent }]
      })
    });

    if (!response.ok) {
      const detail = await response.text();
      return res.status(502).json({
        error: "[v8] The AI service returned an error: " + detail.slice(0, 400)
      });
    }

    const data = await response.json();
    const stopReason = data.stop_reason;

    const toolBlock = (data.content || []).find((c) => c.type === "tool_use");
    const parsed = toolBlock ? toolBlock.input : null;

    if (!parsed || typeof parsed !== "object") {
      if (stopReason === "max_tokens") {
        return res.status(502).json({
          error: "[v8] The critique exceeded the length limit. Try fewer lenses, or a shorter report."
        });
      }
      return res.status(502).json({ error: "[v8] The AI did not return a structured result. Please try again." });
    }

    const result = {
      overallSummary: typeof parsed.overallSummary === "string" ? parsed.overallSummary : "",
      lenses: normalizeLenses(parsed.lenses),
      truncated: truncated
    };

    if (!result.lenses.length) {
      return res.status(502).json({ error: "[v8] The AI returned no stakeholder lenses. Please try again." });
    }

    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({
      error: "[v8] Something went wrong contacting the AI service: " + String(err).slice(0, 300)
    });
  }
}
