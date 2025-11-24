// index.js
require("dotenv").config();
const express = require("express");
const { masterPromptA, phasePromptsRaw } = require("./prompts");

const app = express();
app.use(express.json());

console.log("Loaded Master Prompt A length:", masterPromptA.length);
console.log("Loaded Phase B Prompts length:", phasePromptsRaw.length);

app.get("/", (req, res) => {
  res.send("Studio AZ AI Setter backend is running");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`AI Setter server listening on port ${PORT}`);
});
