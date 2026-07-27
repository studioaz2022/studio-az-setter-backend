/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "node",
  roots: ["<rootDir>"],
  // Only *.test.js files are suites. Without this, shared fixtures under
  // __tests__/helpers/ are collected as empty suites and fail the run.
  testMatch: ["**/*.test.js"],
  // Stubs provider credentials so module-scope SDK clients can construct, and
  // so no unit test can reach a live API. See jest.setup.js.
  setupFiles: ["<rootDir>/jest.setup.js"],
  // These two are hand-run exploration scripts, not suites: they load the real
  // .env and make live, billable, non-deterministic LLM calls. Keeping them out
  // of `npm test` is what makes the suite usable as a merge gate.
  // Run one deliberately with:
  //   npx jest --testPathIgnorePatterns "/node_modules/" __tests__/objection_threads.test.js
  testPathIgnorePatterns: [
    "/node_modules/",
    "<rootDir>/__tests__/objection_library_live.test.js",
    "<rootDir>/__tests__/objection_threads.test.js",
  ],
  collectCoverageFrom: [
    "src/**/*.js",
    "!src/**/index.js",
  ],
  clearMocks: true,
  // Suites that boot the Express app (server_webhooks) transitively construct
  // the Supabase client, whose realtime socket keeps the event loop alive, so
  // jest never exits on its own. Tests themselves complete and report normally.
  // Without this, `npm test` hangs forever and is useless as a merge gate.
  forceExit: true,
};

