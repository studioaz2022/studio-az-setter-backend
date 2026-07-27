/**
 * Test environment bootstrap. Runs before every suite.
 *
 * `src/server/app.js` constructs an OpenAI client at module scope
 * (`new OpenAI({ apiKey: process.env.LLM_API_KEY })`), and the SDK throws
 * "Missing credentials" at construction time. Any suite that requires the app
 * — directly or transitively — therefore fails to load without this.
 *
 * These are deliberately FORCED rather than defaulted. Overwriting a real key
 * that happens to be in the developer's shell is the point: a unit test must
 * never be able to spend money or reach a live provider. Suites that genuinely
 * want live calls are excluded from `npm test` in jest.config.js and run
 * explicitly.
 */
process.env.NODE_ENV = process.env.NODE_ENV || "test";

process.env.LLM_API_KEY = "test-llm-key-not-real";
process.env.OPENAI_API_KEY = "test-openai-key-not-real";
process.env.ANTHROPIC_API_KEY = "test-anthropic-key-not-real";

// `src/clients/supabaseClient.js` calls createClient() at module scope, which
// throws "supabaseUrl is required" when unset. This used to be masked: two
// exploration suites called dotenv.config() and leaked the real .env into
// whichever worker ran them, so unrelated suites passed by accident. Those are
// excluded from `npm test` now, so the stubs have to be explicit.
process.env.SUPABASE_URL = "https://test-project.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key-not-real";
