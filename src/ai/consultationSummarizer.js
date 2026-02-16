// consultationSummarizer.js
// Uses OpenAI (ChatGPT) to generate a structured consultation summary from
// a Fireflies transcript. Output format deliberately matches Gemini's section
// headers so the existing iOS parseGeminiNotes() parser works without changes.

require("dotenv").config();
const OpenAI = require("openai");

const openai = new OpenAI({
  apiKey: process.env.LLM_API_KEY,
});

const TAG = "[ConsultationSummarizer]";

/**
 * Summarize a consultation transcript using ChatGPT.
 *
 * @param {string} rawTranscript - Formatted transcript text (speaker-labeled dialogue)
 * @param {object} opts
 * @param {string} [opts.clientName] - Client's name for context
 * @returns {Promise<string>} Structured summary matching Gemini notes format
 */
async function summarizeConsultation(rawTranscript, { clientName } = {}) {
  const contextBlock = clientName ? `\nClient name: ${clientName}\n` : "";

  const systemPrompt = `You are a professional tattoo studio assistant. You produce structured consultation summaries from meeting transcripts.

IMPORTANT: Only summarize what was ACTUALLY discussed in the transcript. Do not infer or include information that was not spoken about in the call.

Your output MUST follow this exact format with these exact section headers (no markdown, no extra formatting):

Summary
* [Key point 1: Brief title]: [Description]
* [Key point 2: Brief title]: [Description]
* [Key point 3: Brief title]: [Description]

Decisions
* [Decision 1]
* [Decision 2]

More details:
* [Detail 1]
* [Detail 2]

Suggested next steps
* [Step 1]
* [Step 2]

Rules:
- Use plain text only — no markdown headers (#), no bold (**), no emojis
- Each section header must appear on its own line, exactly as shown above
- Each bullet point must start with "* " (asterisk space)
- In the Summary section, use "Title: Description" format for each bullet
- Only include information that was explicitly discussed in the transcript — do not add external context or assumptions
- Focus on tattoo-related decisions if they were discussed: design, placement, size, style, color, budget, sessions, scheduling
- If the transcript is mostly casual conversation with little tattoo content, summarize what was actually discussed and note that no specific tattoo decisions were made
- Keep it concise but thorough — capture all actionable information from the call`;

  const userPrompt = `${contextBlock}
Transcript:
${rawTranscript}`;

  console.log(`${TAG} Generating summary (${rawTranscript.length} chars of transcript)`);

  const completion = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0.3,
    max_tokens: 1500,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });

  const summary = completion.choices[0]?.message?.content?.trim() || "";
  console.log(`${TAG} Summary generated (${summary.length} chars)`);
  return summary;
}

module.exports = { summarizeConsultation };
