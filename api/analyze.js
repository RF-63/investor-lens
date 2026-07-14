// Vercel Serverless Function — the "stakeholder brain".
// Runs on Vercel's servers (never in the browser), so the secret Anthropic API
// key stays hidden. The browser sends the report text plus which stakeholder
// lenses to apply; this asks Claude to critique the report through each of
// those voices and returns structured results.
//
// GET  /api/analyze  -> returns the list of available lenses (for the picker)
// POST /api/analyze  -> { text, companyName, lensIds[] } -> the critique
//
// TO ADD A NEW STAKEHOLDER LENS: add one entry to the LENSES array below,
// with a "group" of "primary", "secondary" or "silent". Nothing else needs to
// change — the picker and the prompt build themselves. // v13-groups

// ---- Settings you can safely change later -------------------------------
const MODEL = "claude-sonnet-5";      // swap to "claude-opus-4-8" for deeper (pricier) analysis
const MAX_OUTPUT_TOKENS = 32000;      // preferred budget for the critique
const SAFE_OUTPUT_TOKENS = 16000;     // known-good fallback if the model rejects the bigger budget
const MAX_INPUT_CHARS = 300000;       // protects you from runaway cost on huge reports
// -------------------------------------------------------------------------

// The three partitions, after Clarkson (1995) on primary vs secondary
// stakeholders, and Driscoll & Starik (2004) on the "silent" stakeholder that
// holds a genuine stake but has no voice of its own.
const GROUPS = [
  {
    id: "primary",
    name: "Primary stakeholders",
    note: "Those without whose continued participation the company could not survive (Clarkson, 1995)."
  },
  {
    id: "secondary",
    name: "Secondary stakeholders",
    note: "Not essential to survival, but they influence the company or are affected by it (Clarkson, 1995)."
  },
  {
    id: "silent",
    name: "Silent stakeholders",
    note: "A genuine stake in the company's conduct, but no voice of their own (Driscoll & Starik, 2004)."
  }
];

// The more voices are ticked, the fewer points each may make, so the combined
// answer always fits the response budget.
function maxPointsFor(count) {
  if (count <= 4) return 8;
  if (count <= 6) return 6;
  if (count <= 9) return 5;
  return 4;
}

const LENSES = [
  // ---------------------------- PRIMARY ----------------------------------
  {
    id: "equity-generalist",
    group: "primary",
    name: "Equity Investors (Generalist)",
    blurb: "Fundamentals, valuation, capital allocation",
    persona: `A balanced institutional equity investor weighing growth, profitability, competitive position, capital allocation, risk, and valuation. Draws on fundamental analysis (Graham & Dodd, "Security Analysis"; Penman, "Financial Statement Analysis and Security Valuation"). Assesses revenue quality, margin trends, cash generation, balance-sheet strength, returns on capital, and whether management's narrative matches the numbers.`
  },
  {
    id: "debt-credit",
    group: "primary",
    name: "Debt Investors / Credit Analysts",
    blurb: "Leverage, liquidity, covenants, refinancing risk",
    persona: `A credit analyst or bondholder with an asymmetric payoff: capped upside, full downside. Cares far less about growth than about the company's ability to service and repay debt through a downturn. Focus areas: leverage (net debt/EBITDA) and its trajectory, interest coverage, liquidity and undrawn facilities, the debt maturity profile and any refinancing wall, covenant headroom, cash conversion and the gap between reported earnings and cash, and off-balance-sheet or quasi-debt obligations — leases, pension deficits, factoring, contingent liabilities and guarantees. Watches for shareholder-friendly actions that transfer value away from creditors (buybacks, special dividends, debt-funded M&A) — the classic agency conflict between equity and debt (Jensen & Meckling, 1976, "Theory of the Firm," Journal of Financial Economics). Grounded in structural credit risk (Merton, 1974, "On the Pricing of Corporate Debt," Journal of Finance) and distress prediction (Altman, 1968, "Financial Ratios, Discriminant Analysis and the Prediction of Corporate Bankruptcy," Journal of Finance). Deeply sceptical of "adjusted" EBITDA and generous add-backs.`
  },
  {
    id: "esg-stewardship",
    group: "primary",
    name: "ESG / Governance-Oriented Investors",
    blurb: "Board quality, pay, shareholder rights, material ESG",
    persona: `An ownership-minded buy-side analyst who integrates ESG and governance into the investment case and thinks like a long-term steward of capital, not a box-ticker. Focus areas: board quality and independence, ownership and control structures (dual-class shares, controlling holders), executive remuneration and its alignment with long-term value creation, shareholder rights and minority protections, capital-allocation stewardship, audit quality, and succession. Assesses whether ESG disclosure is decision-useful and financially material (Khan, Serafeim & Yoon, 2016, "Corporate Sustainability: First Evidence on Materiality," The Accounting Review) rather than immaterial box-ticking, and distinguishes substantive commitments from greenwashing (Lyon & Montgomery, 2015, "The Means and End of Greenwash," Organization & Environment). Grounded in the governance-quality literature (Gompers, Ishii & Metrick, 2003, "Corporate Governance and Equity Prices"; Bebchuk, Cohen & Ferrell, 2009, "What Matters in Corporate Governance?") and active-ownership research (Dimson, Karakaş & Li, 2015, "Active Ownership," Review of Financial Studies). References ISSB/SASB, TCFD, GRI and stewardship codes. Checks whether targets have clear baselines, timelines, scope and assurance.`
  },
  {
    id: "activist-short",
    group: "primary",
    name: "Activist Short-Seller",
    blurb: "Red flags, accounting quality, narrative vs numbers",
    persona: `An adversarial lens hunting for red flags: aggressive or opaque accounting, deteriorating cash conversion, related-party dealings, weak governance, misaligned incentives, undisclosed liabilities or risks, and gaps between management's tone and the substance beneath it. Probes for narrative-versus-numbers inconsistencies and cues that management may be obscuring problems (Kahneman & Tversky on framing and overconfidence).`
  },
  {
    id: "customers",
    group: "primary",
    name: "Customers",
    blurb: "Product quality and safety, pricing conduct, privacy, fair terms",
    persona: `The voice of the people who buy from the company. Focus areas: product quality, safety and recalls; honest marketing versus overclaiming; pricing conduct (including price rises, shrinkflation and exploitation of captive or vulnerable customers); fairness and clarity of contract terms; service reliability; complaint handling and redress; data privacy and how customer data is used; durability, repairability and planned obsolescence; and accessibility. Reads customer-satisfaction and retention metrics sceptically, asking whether they are independently measured or self-serving. Grounded in evidence that customer satisfaction is an intangible asset that flows through to shareholder value (Fornell, Mithas, Morgeson & Krishnan, 2006, "Customer Satisfaction and Stock Prices: High Returns, Low Risk," Journal of Marketing; Fornell et al., 1996, "The American Customer Satisfaction Index," Journal of Marketing). Notes where the report celebrates customer-centricity while disclosing rising complaints, falling service levels, or safety incidents.`
  },
  {
    id: "suppliers",
    group: "primary",
    name: "Suppliers / Value-Chain Partners",
    blurb: "Payment terms, power imbalance, dependency, sourcing demands",
    persona: `The voice of the firms that supply the company. Focus areas: payment terms and late payment (and whether working-capital improvements were achieved by simply paying suppliers later); the balance of power in contracting, unilateral changes to terms, and hold-up risk; supplier concentration and mutual dependency; the reliability of forecasts and orders; whether cost inflation can be passed through; the burden of audits, certifications and sustainability requirements imposed without commensurate price support or longer-term commitments; and investment in supplier development and capability. Grounded in transaction-cost economics and the hold-up problem (Williamson, 1985, "The Economic Institutions of Capitalism") and in the relational view of competitive advantage, where value is co-created with partners rather than extracted from them (Dyer & Singh, 1998, "The Relational View," Academy of Management Review). Watches for reports that celebrate cash-flow improvement and supplier "partnership" in the same breath.`
  },
  {
    id: "labour",
    group: "primary",
    name: "Employees & Organised Labour",
    blurb: "Safety, pay, restructuring, culture, workforce disclosure",
    persona: `A works-council member or trade-union analyst reading the report on behalf of the workforce. Focus areas: health and safety (injury and fatality rates, and whether contractors are included), pay — including living wages, the gender pay gap, and the CEO-to-median-worker pay ratio — job security, restructuring and redundancies, use of precarious, temporary and outsourced labour, collective bargaining coverage and freedom of association (ILO core conventions), training and skills investment, turnover and engagement, whistleblowing channels, and workplace culture and discrimination. Notes where workforce disclosure is thin, selective, or reported only as inputs (e.g. training hours) rather than outcomes. Grounded in the evidence that workforce quality is financially material and often under-priced by markets (Edmans, 2011, "Does the stock market fully value intangibles? Employee satisfaction and equity prices," Journal of Financial Economics) and in the industrial-relations literature (Freeman & Medoff, 1984, "What Do Unions Do?"). Sceptical of upbeat culture language that sits alongside layoffs, wage restraint, or rising executive pay.`
  },
  {
    id: "communities",
    group: "primary",
    name: "Local Communities",
    blurb: "Site impacts, land, consultation, social licence to operate",
    persona: `The voice of the communities living alongside the company's operations. Focus areas: site-level environmental and health impacts (air and water pollution, noise, dust, traffic, water abstraction in stressed areas); land acquisition, resettlement and indigenous rights, including free prior informed consent; local employment and procurement; taxes and royalties actually paid in the places affected; the consequences of plant closures and site exits; the quality and good faith of community consultation; and the existence and effectiveness of grievance mechanisms and remedy for harm. Judges whether the company holds a genuine social licence to operate — the ongoing acceptance granted by local communities, which is earned through conduct rather than asserted in a report (Gunningham, Kagan & Thornton, 2004, "Social License and Environmental Protection," Law & Social Inquiry; Prno & Slocombe, 2012, "Exploring the Origins of 'Social License to Operate'," Resources Policy). Sceptical of community-investment and philanthropy figures presented in place of evidence that impacts were avoided or remedied.`
  },
  {
    id: "regulators",
    group: "primary",
    name: "Regulators & Supervisors",
    blurb: "Compliance, disclosure adequacy, controls, enforcement",
    persona: `A supervisor or securities regulator assessing whether the report meets its obligations. Focus areas: completeness and adequacy of disclosure against applicable requirements (CSRD/ESRS, ISSB/IFRS S1-S2, TCFD, local securities and company law); whether the materiality assessment is properly conducted and evidenced; consistency between the financial statements, the management report and the sustainability statements; the quality of assurance obtained (limited versus reasonable) and what it actually covers; internal controls and any identified weaknesses; disclosure of litigation, investigations, fines and sanctions; competition and market conduct; tax compliance and country-by-country transparency; anti-bribery, anti-money-laundering and sanctions compliance; and data protection. Especially alert to boilerplate risk disclosure that could belong to any company, rather than entity-specific risks. Grounded in the disclosure literature (Healy & Palepu, 2001, "Information asymmetry, corporate disclosure, and the capital markets," Journal of Accounting and Economics) and evidence on mandatory sustainability reporting (Christensen, Hail & Leuz, 2021, "Mandatory CSR and sustainability reporting," Review of Accounting Studies).`
  },

  // --------------------------- SECONDARY ---------------------------------
  {
    id: "ngo",
    group: "secondary",
    name: "NGOs / Civil Society",
    blurb: "Human rights, value-chain harms, lobbying, greenwashing",
    persona: `A seasoned campaigner from an environmental and human-rights NGO, reading the report adversarially and on behalf of affected people. Scrutinises human-rights due diligence against the UN Guiding Principles on Business and Human Rights (Ruggie, 2011) and emerging due-diligence law (e.g. CSDDD): forced and child labour in the supply chain, living wages, worker safety in supplier factories, land rights and free prior informed consent of affected communities, indigenous rights, pollution and health impacts on frontline communities. Also examines corporate political influence — lobbying, trade-association memberships, and political donations — and whether they contradict the company's stated commitments; tax transparency; and remedy and grievance mechanisms for those harmed. Highly attuned to greenwashing and selective disclosure (Lyon & Montgomery, 2015, "The Means and End of Greenwash," Organization & Environment) and to the gap between policy commitments and evidence of implementation (Den Hond & de Bakker, 2007, "Ideologically Motivated Activism," Academy of Management Review). Insists on evidence, not intention.`
  },
  {
    id: "journalists",
    group: "secondary",
    name: "Investigative Journalists",
    blurb: "What's buried, quietly dropped, or conspicuously unsaid",
    persona: `An investigative business journalist reading the report for the story management would rather not tell. Hunts for what is buried in footnotes; definitions and baselines quietly restated or changed from last year; targets softened, delayed or dropped without acknowledgement; segments newly aggregated to obscure a decline; restatements; euphemism ("transformation programme" for mass redundancy); executive pay rising alongside layoffs or wage restraint; subsidiaries in secrecy jurisdictions; litigation, investigations and settlements mentioned only in passing; and discrepancies between the report and the public record. Pays as much attention to what is NOT said as to what is. Grounded in the literature on impression management and discretionary disclosure in corporate narratives (Merkl-Davies & Brennan, 2007, "Discretionary Disclosure Strategies in Corporate Narratives," Journal of Accounting Literature) and on obfuscation, where complexity and poor readability conceal bad news (Li, 2008, "Annual report readability, current earnings, and earnings persistence," Journal of Accounting and Economics).`
  },
  {
    id: "insurers",
    group: "secondary",
    name: "Insurers & Underwriters",
    blurb: "Physical risk, liability, catastrophe exposure, insurability",
    persona: `An underwriter deciding whether, and at what price, to carry this company's risk. Focus areas: exposure of physical assets and operations to climate hazards (flood, wildfire, storm, heat, drought) and whether the company discloses asset-level, location-specific exposure rather than generic statements; business-interruption and supply-chain concentration risk; product and environmental liability; directors' and officers' exposure; litigation risk, including the fast-growing field of climate litigation; safety and operational track record, incidents and near-misses; cyber risk; decommissioning and remediation obligations; and the quality of risk management, controls and contingency planning. Alert to rising insurability limits — risks that are becoming uninsurable or repriced sharply — and to whether the company acknowledges this. Grounded in the literature on climate risk to insurers and the financial system (Mills, 2005, "Insurance in a Climate of Change," Science; Battiston, Mandel, Monasterolo, Schütze & Visentin, 2017, "A climate stress-test of the financial system," Nature Climate Change) and the TCFD distinction between physical, transition and liability risk.`
  },
  {
    id: "gatekeepers",
    group: "secondary",
    name: "Gatekeepers (Auditors, ESG Rating Agencies)",
    blurb: "Audit quality, assurance, data comparability, rating divergence",
    persona: `The professional gatekeepers whose job is to verify and rate what the company says (Coffee, 2006, "Gatekeepers: The Professions and Corporate Governance"). From the audit side: auditor tenure and independence, the ratio of non-audit to audit fees, key audit matters and what they reveal about judgement-heavy areas, going-concern statements, restatements, and identified internal-control weaknesses (DeFond & Zhang, 2014, "A review of archival auditing research," Journal of Accounting and Economics). From the ESG-rating and data side: whether sustainability data is complete, comparable year-on-year, and prepared on a stated basis; the level of assurance obtained (limited versus reasonable) and precisely which metrics it covers; missing or estimated Scope 3; bespoke, non-standard or unbenchmarkable metrics; and disclosure gaps that force raters to estimate. Understands that ESG ratings diverge sharply because of measurement and scope differences, and flags where the company's disclosure makes it easy to be rated generously (Berg, Kölbel & Rigobon, 2022, "Aggregate Confusion: The Divergence of ESG Ratings," Review of Finance).`
  },

  // ----------------------------- SILENT ----------------------------------
  {
    id: "nature",
    group: "silent",
    name: "Nature",
    blurb: "Ecological limits, biodiversity, impacts and dependencies",
    persona: `The voice of the natural environment itself — a stakeholder with a genuine stake but no ability to speak (Driscoll & Starik, 2004, "The Primordial Stakeholder: Advancing the Conceptual Consideration of Stakeholder Status for the Natural Environment," Journal of Business Ethics). Judges the company against ecological limits rather than peer benchmarks or reputational optics. Assesses the company's impacts AND dependencies on nature: greenhouse gas emissions (including Scope 3), biodiversity and habitat loss, land-use change, freshwater use and pollution, resource extraction, waste and circularity. Asks whether targets are absolute rather than intensity-based, science-based, and consistent with a safe operating space for humanity (Rockström et al., 2009, "A Safe Operating Space for Humanity," Nature; Steffen et al., 2015, Science), whether the company recognises its dependence on ecosystem services and natural capital (Costanza et al., 1997, Nature; Dasgupta, 2021, "The Economics of Biodiversity: The Dasgupta Review"), and whether nature-related risks are disclosed in line with TNFD and SBTN guidance. Is sharply sceptical of offsetting used in place of absolute reduction, of intensity metrics that mask absolute growth, and of externalities the company benefits from but never books.`
  },
  {
    id: "future-generations",
    group: "silent",
    name: "Future Generations",
    blurb: "Intergenerational equity, stranded assets, short-termism",
    persona: `The voice of people not yet born, who will inherit the consequences of today's decisions but have no say in them. Asks a single organising question: are today's returns being earned, or borrowed from tomorrow? Focus areas: whether long-lived assets and infrastructure lock in decades of future emissions or environmental damage, and whether stranded-asset risk is acknowledged; decommissioning, remediation, closure and clean-up liabilities, and whether they are fully provisioned or quietly deferred; pension and other long-dated obligations; depletion of natural, human and social capital that will not appear on any balance sheet; and under-investment in R&D, maintenance and capability while cash is returned via buybacks and dividends — the well-documented willingness of managers to sacrifice long-term value to hit short-term earnings targets (Graham, Harvey & Rajgopal, 2005, "The economic implications of corporate financial reporting," Journal of Accounting and Economics). Grounded in the definition of sustainable development as meeting present needs without compromising the ability of future generations to meet their own (WCED, 1987, "Our Common Future" — the Brundtland Report), and in the economics of intergenerational discounting and catastrophic risk (Stern, 2007, "The Economics of Climate Change: The Stern Review"; Weitzman, 2009, "On Modeling and Interpreting the Economics of Catastrophic Climate Change," Review of Economics and Statistics). Deeply sceptical of distant target dates that fall safely beyond the tenure of everyone currently accountable.`
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

  // Ease off slightly only when many voices are ticked, so the combined answer
  // still fits comfortably even on the fallback budget.
  const maxPoints = maxPointsFor(selected.length);

  return `You are a panel of stakeholder voices reviewing a company's annual report or sustainability report. Each voice produces a candid, evidence-based critique — the kind of frank assessment given behind closed doors, not a marketing summary. Be specific, sceptical of management spin, and always ground each point in the document itself.

You reason from the following distinct lenses. For EACH lens, produce points of PRAISE and points of CRITICISM, strictly from that stakeholder's point of view and priorities. Do not blur the voices together: what an investor praises, a campaigner may well criticise, and that tension is the point.

${lensBlocks}

RULES:
- Give up to ${maxPoints} items of praise and up to ${maxPoints} items of criticism per lens. Be substantive: where the report genuinely supports it, work toward the upper end rather than stopping at two or three. But never pad — drop a point rather than make a weak one.
- Cover all ${selected.length} lenses. Never exhaust the response elaborating on an early lens and leave a later one thin.
- Every point MUST include a short verbatim quote from the provided report text that the point responds to. Keep each quote to a single sentence, roughly 30 words maximum; if the relevant passage is longer, quote only the key clause. Quote exactly; do not paraphrase inside the quote field. If you genuinely cannot find supporting text for a point, omit that point.
- Keep each "point" to 1-2 sentences. Keep "overallSummary" to 2-3 sentences, and make it note the sharpest tension BETWEEN the stakeholder voices where one exists.
- Be concrete. Prefer "operating margin narrative omits the 220bp decline shown in the segment table" over generic statements.
- It is acceptable for a lens to have more criticism than praise, or vice versa. Do not force balance.
- Silence in the report is itself findable: absence of a disclosure a stakeholder would expect is a legitimate criticism, as long as you quote the passage where it should have appeared or where a weaker claim was made instead.
- Do not invent figures not present in the text.

Provide your analysis by calling the "submit_analysis" tool.

The tool takes a FLAT list called "findings". Each finding is one point, tagged with which lens makes it and whether it is praise or criticism. Cover all ${selected.length} lenses, using exactly these lens names: ${names}. Emit "findings" as a real list of objects — never as a single block of text.`;
}

// The tool defines the structure Claude must return. It is deliberately FLAT:
// one list of findings, each tagged with its lens. Deeply nested schemas get
// collapsed into text by the model; flat ones don't. // v11-flat
function buildTool(selected) {
  const lensNames = selected.map((l) => l.name);
  return {
    name: "submit_analysis",
    description: "Submit the stakeholder critique of the report as a flat list of findings.",
    input_schema: {
      type: "object",
      properties: {
        overallSummary: {
          type: "string",
          description: "2-3 sentence executive summary, noting the sharpest tension between the stakeholder voices."
        },
        findings: {
          type: "array",
          description: "A flat list. Each item is ONE point made by ONE stakeholder lens.",
          items: {
            type: "object",
            properties: {
              lens: {
                type: "string",
                enum: lensNames,
                description: "Which stakeholder lens makes this point."
              },
              type: {
                type: "string",
                enum: ["praise", "criticism"],
                description: "Whether this point is praise or criticism."
              },
              point: { type: "string", description: "1-2 sentence point." },
              quote: { type: "string", description: "Short verbatim quote from the report supporting this point." }
            },
            required: ["lens", "type", "point", "quote"]
          }
        }
      },
      required: ["overallSummary", "findings"]
    }
  };
}

function tryParse(str) {
  try { return JSON.parse(str); } catch (e) { return null; }
}

// Models occasionally hand back a nested structure as a JSON *string* rather
// than a real list/object. Unwrap that wherever it happens.
function unwrap(value) {
  if (typeof value === "string") return tryParse(value);
  return value;
}

// Last resort. If the model returned text that is malformed or truncated, pull
// out whatever individual findings we can still recognise. Our findings are
// flat objects, so each one is a brace-pair with no nested braces inside.
function salvageFindings(text) {
  if (typeof text !== "string") return [];
  const out = [];
  const re = /\{[^{}]*"lens"[^{}]*\}/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const obj = tryParse(m[0]);
    if (obj && obj.lens && obj.point) out.push(obj);
  }
  return out;
}

// Accept every shape the model has actually produced:
//  - findings as a proper list                     (the happy path)
//  - findings as a JSON string of a list
//  - the WHOLE payload (summary + findings) stuffed into findings as a string
//  - findings as an object keyed by index
//  - any of the above, truncated or malformed      (-> salvage)
function coercePayload(parsed) {
  let summary = typeof parsed.overallSummary === "string" ? parsed.overallSummary : "";
  let raw = parsed.findings;

  const inner = unwrap(raw);
  if (Array.isArray(inner)) {
    raw = inner;
  } else if (inner && typeof inner === "object") {
    // The model nested the whole payload inside the findings field.
    if (!summary && typeof inner.overallSummary === "string") summary = inner.overallSummary;
    raw = inner.findings !== undefined ? inner.findings : Object.values(inner);
  }

  let list = unwrap(raw);
  if (!Array.isArray(list)) list = [];

  if (!list.length) {
    if (typeof parsed.findings === "string") list = salvageFindings(parsed.findings);
    else if (typeof raw === "string") list = salvageFindings(raw);
  }

  return { overallSummary: summary, findings: list };
}

// Normalize a single praise/criticism entry to { point, quote }.
function normalizeItem(item) {
  let it = item;
  if (typeof it === "string") {
    const asObject = tryParse(it);
    if (asObject && typeof asObject === "object") {
      it = asObject;
    } else {
      return { point: it, quote: "" }; // plain sentence, no quote attached
    }
  }
  if (!it || typeof it !== "object") return null;
  const point = typeof it.point === "string" ? it.point : "";
  const quote = typeof it.quote === "string" ? it.quote : "";
  if (!point && !quote) return null;
  return { point: point, quote: quote };
}

function normalizeItems(items) {
  const list = unwrap(items);
  if (!Array.isArray(list)) return [];
  return list.map(normalizeItem).filter(Boolean);
}

// Match a lens name loosely, so a small wording drift from the model still
// lands in the right bucket rather than being discarded.
function matchLens(name, selected) {
  if (typeof name !== "string" || !name) return null;
  const needle = name.trim().toLowerCase();
  let hit = selected.find((l) => l.name.toLowerCase() === needle);
  if (hit) return hit;
  hit = selected.find((l) => l.name.toLowerCase().includes(needle) || needle.includes(l.name.toLowerCase()));
  if (hit) return hit;
  // last resort: match on the first distinctive word (e.g. "nature", "equity")
  const word = needle.split(/[^a-z]+/).filter((w) => w.length > 3)[0];
  if (word) hit = selected.find((l) => l.name.toLowerCase().includes(word));
  return hit || null;
}

// Turn the flat findings list back into the per-lens shape the page expects.
// Tolerates findings arriving as a JSON string, and items likewise.
function groupFindings(findings, selected) {
  const list = unwrap(findings);
  const items = Array.isArray(list) ? list : [];

  const buckets = selected.map((l) => ({ name: l.name, praise: [], criticism: [] }));
  const byName = {};
  selected.forEach((l, i) => { byName[l.name] = buckets[i]; });

  items.forEach((entry) => {
    const f = unwrap(entry);
    if (!f || typeof f !== "object") return;

    const lens = matchLens(f.lens, selected);
    if (!lens) return;

    const point = typeof f.point === "string" ? f.point.trim() : "";
    const quote = typeof f.quote === "string" ? f.quote.trim() : "";
    if (!point) return;

    const isPraise = String(f.type || "").trim().toLowerCase().startsWith("prais");
    const bucket = byName[lens.name];
    (isPraise ? bucket.praise : bucket.criticism).push({ point: point, quote: quote });
  });

  // Drop any lens the model said nothing about at all.
  return buckets.filter((b) => b.praise.length || b.criticism.length);
}

export default async function handler(req, res) {
  // The page asks for the lens list on load, to build the picker.
  if (req.method === "GET") {
    return res.status(200).json({
      groups: GROUPS,
      lenses: LENSES.map((l) => ({ id: l.id, name: l.name, blurb: l.blurb, group: l.group }))
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

  // Ask Claude once, at a given response budget.
  const callClaude = (maxTokens) =>
    fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        system: buildSystemPrompt(selected),
        tools: [buildTool(selected)],
        tool_choice: { type: "tool", name: "submit_analysis" },
        messages: [{ role: "user", content: userContent }]
      })
    });

  try {
    // Try the generous budget. If this model won't allow one that large, it
    // says so — in which case quietly retry at the known-good size rather
    // than failing in the user's face. // v12-depth
    let response = await callClaude(MAX_OUTPUT_TOKENS);

    if (!response.ok) {
      const detail = await response.text();
      if (/max_tokens/i.test(detail)) {
        response = await callClaude(SAFE_OUTPUT_TOKENS);
        if (!response.ok) {
          const detail2 = await response.text();
          return res.status(502).json({
            error: "[v12] The AI service returned an error: " + detail2.slice(0, 400)
          });
        }
      } else {
        return res.status(502).json({
          error: "[v12] The AI service returned an error: " + detail.slice(0, 400)
        });
      }
    }

    const data = await response.json();
    const stopReason = data.stop_reason;

    // If the answer hit the length limit, the structured result is incomplete
    // (often an empty shell). Catch this first and say so plainly.
    if (stopReason === "max_tokens") {
      return res.status(502).json({
        error: "[v14] The critique ran past the length limit and was cut off. Tick fewer stakeholder voices, or use a shorter report."
      });
    }

    const toolBlock = (data.content || []).find((c) => c.type === "tool_use");
    const parsed = toolBlock ? toolBlock.input : null;

    if (!parsed || typeof parsed !== "object") {
      return res.status(502).json({ error: "[v14] The AI did not return a structured result. Please try again." });
    }

    // Accepts every shape the model has been observed to produce. // v14-coerce
    const payload = coercePayload(parsed);

    const result = {
      overallSummary: payload.overallSummary,
      lenses: groupFindings(payload.findings, selected),
      truncated: truncated
    };

    if (!result.lenses.length) {
      // Report exactly what came back, so the cause is never a guess.
      const raw = parsed.findings;
      const shape = Array.isArray(raw) ? "array[" + raw.length + "]" : typeof raw;
      let sample = "";
      try { sample = JSON.stringify(raw).slice(0, 220); } catch (e) { sample = "(unserializable)"; }
      return res.status(502).json({
        error: "[v14] The AI returned no usable findings. (stop=" + stopReason +
               "; shape=" + shape + "; sample=" + sample + ")"
      });
    }

    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({
      error: "[v11] Something went wrong contacting the AI service: " + String(err).slice(0, 300)
    });
  }
}
