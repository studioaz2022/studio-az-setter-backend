const { generateOpenerForContact } = require("./aiClient");

async function handleInboundMessage({ contact, aiPhase, leadTemperature, latestMessageText }) {
  const aiResult = await generateOpenerForContact({ contact, aiPhase, leadTemperature, latestMessageText });

  return {
    aiResult,
    ai_phase: aiResult?.meta?.aiPhase || aiPhase || null,
    lead_temperature: aiResult?.meta?.leadTemperature || leadTemperature || null,
    flags: {},
  };
}

module.exports = {
  handleInboundMessage,
};

