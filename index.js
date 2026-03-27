require("dotenv").config({ quiet: true });
const { createApp } = require("./src/server/app");

const PORT = process.env.PORT || 3000;
const app = createApp();

app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
