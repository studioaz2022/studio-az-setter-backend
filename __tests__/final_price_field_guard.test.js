/**
 * Phase 0 guard: prevent regression of the deprecated quote field.
 *
 * The `quote_to_client` GHL field (and the phantom `tattoo_quote` reference)
 * are deprecated. `final_price` is the single source of truth for the agreed
 * tattoo quote. This test asserts that production code does not WRITE to the
 * deprecated keys. Reads are still allowed (legacy fallback path is intentional).
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "src");

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

describe("Phase 0 — deprecated quote field guard", () => {
  const sourceFiles = walk(SRC);

  test("no production code WRITES to 'quote_to_client'", () => {
    const offenders = [];
    for (const file of sourceFiles) {
      const code = stripComments(fs.readFileSync(file, "utf8"));
      // Catch object-literal write keys: 'quote_to_client': X  or  "quote_to_client": X
      const writeKeyPattern = /['"]quote_to_client['"]\s*:/;
      if (writeKeyPattern.test(code)) {
        offenders.push(path.relative(ROOT, file));
      }
    }
    if (offenders.length) {
      throw new Error(
        `quote_to_client is deprecated as a write target. ` +
          `Use GHL_CUSTOM_FIELD_IDS.FINAL_PRICE instead. Offending files:\n  ${offenders.join("\n  ")}`
      );
    }
  });

  test("no production code references the phantom 'tattoo_quote' field", () => {
    // tattoo_quote does not exist in GHL — any reference is dead code or a typo.
    const offenders = [];
    for (const file of sourceFiles) {
      const code = stripComments(fs.readFileSync(file, "utf8"));
      if (/\btattoo_quote\b/.test(code)) {
        offenders.push(path.relative(ROOT, file));
      }
    }
    if (offenders.length) {
      throw new Error(
        `tattoo_quote is not a real GHL field. Use final_price (with quote_to_client fallback for reads). Offending files:\n  ${offenders.join("\n  ")}`
      );
    }
  });
});
