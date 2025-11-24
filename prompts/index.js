// prompts/index.js
const fs = require("fs");
const path = require("path");

function loadFile(relativePath) {
  const fullPath = path.join(__dirname, relativePath);
  return fs.readFileSync(fullPath, "utf8");
}

const masterPromptA = loadFile("masterA_v2.txt");
const phasePromptsRaw = loadFile("phaseB_v2.txt");

// For now we'll just export both raw strings.
// Later we can parse phaseB into a map if we want.
module.exports = {
  masterPromptA,
  phasePromptsRaw,
};
