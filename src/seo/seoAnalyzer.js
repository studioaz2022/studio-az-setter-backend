// seoAnalyzer.js
// Claude-powered SEO analysis — feeds collected data to LLM for actionable recommendations

require("dotenv").config({ quiet: true });
const Anthropic = require("@anthropic-ai/sdk").default;

const anthropic = new Anthropic({ apiKey: process.env.LLM_API_KEY });

const SYSTEM_PROMPT = `You are an expert local SEO consultant specializing in barbershops and tattoo shops in Minneapolis, MN. You analyze SEO data and provide specific, actionable recommendations.

Your client runs two businesses:
- Studio AZ Barbershop (minneapolisbarbershop.com) — luxury barbershop in the North Loop, Minneapolis
- Studio AZ Tattoo (tattooshopminneapolis.com) — upscale tattoo studio in the North Loop, Minneapolis

When analyzing data:
1. Prioritize recommendations by impact (what will move the needle most)
2. Be specific — don't say "improve content", say exactly what to do
3. Focus on LOCAL SEO signals (Google Maps, Local Pack, "near me" searches)
4. Consider the Minneapolis market and competitive landscape
5. Flag any quick wins that can be done immediately in GHL page builder
6. Note seasonal trends if relevant (Minneapolis weather affects search patterns)

Format your response with clear sections:
- 🏆 Quick Wins (can do today)
- 📊 Key Insights (what the data tells us)
- 🎯 Priority Actions (ranked by impact)
- 📈 Growth Opportunities (longer-term plays)`;

/**
 * Run a comprehensive SEO analysis using Claude.
 *
 * @param {object} data - Combined SEO data from all sources
 * @param {string} data.site - "barbershop", "tattoo", or "both"
 * @param {object} data.searchConsole - Search Console performance data
 * @param {object} data.gbpInsights - Google Business Profile metrics
 * @param {object} data.siteAudit - Technical SEO audit results
 * @param {object} data.pageSpeed - PageSpeed Insights results
 * @param {string} data.customQuestion - Optional specific question from the user
 */
async function analyzeData(data) {
  const dataContext = JSON.stringify(data, null, 2);

  const userMessage = data.customQuestion
    ? `Here is the SEO data for my ${data.site} website(s). ${data.customQuestion}\n\nData:\n${dataContext}`
    : `Analyze this SEO data for my ${data.site} website(s) and give me a comprehensive action plan.\n\nData:\n${dataContext}`;

  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 2000,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });

  return {
    analysis: response.content[0].text,
    model: response.model,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}

module.exports = {
  analyzeData,
};
