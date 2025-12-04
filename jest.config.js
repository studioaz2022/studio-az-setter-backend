/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "node",
  roots: ["<rootDir>"],
  collectCoverageFrom: [
    "src/**/*.js",
    "!src/**/index.js",
  ],
  clearMocks: true,
};

