// Buyer prompts for the self-test. Keep in step with buildPrompts() in check/index.html.
export function buildPrompts({ company, category, audience, region, competitor }) {
  const aud = audience || "B2B companies";
  const inReg = region ? " in " + region.replace(/^in\s+/i, "") : "";
  return [
    `What are the best ${category} for ${aud}${inReg}?`,
    `I'm building a shortlist of ${category} for ${aud}${inReg}. Which five should I look at, and why?`,
    competitor ? `What are the best alternatives to ${competitor}? I'm looking at ${category} for ${aud}.` : `Which ${category}${inReg} have the best reviews from ${aud}?`,
    `Compare the leading ${category}${inReg} on features, pricing and customer support.`,
    `What do you know about ${company}? Would you recommend them as one of the ${category} for ${aud}?`,
  ];
}
