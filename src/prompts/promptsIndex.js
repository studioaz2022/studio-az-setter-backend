// src/prompts/promptsIndex.js
const fs = require("fs");
const path = require("path");

function loadFile(relativePath) {
  const fullPath = path.join(__dirname, relativePath);
  return fs.readFileSync(fullPath, "utf8");
}

const masterPromptA = loadFile("master_system_prompt_v3.txt");
const phasePromptsRaw = loadFile("phase_prompts_v3.txt");

// For now we'll just export both raw strings.
// Later we can parse phase prompts into a map if we want.
module.exports = {
  masterPromptA,
  phasePromptsRaw,
};
