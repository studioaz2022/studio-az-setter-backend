# Studio AZ Setter Backend

## CLI Tools
- **git** — Version control. Remote: `git@github.com:studioaz2022/studio-az-setter-backend.git`, branch: `main`.
- **gh** — GitHub CLI for PRs, issues, and repo management.
- **supabase** — Database migrations and management (CLI installed via Homebrew).
- **node/npm** — Runtime and package management.

## Git Workflow
- Commit with clear, descriptive messages.
- Push to `origin main` when explicitly asked.
- Never force-push without asking first.
- Never amend published commits without asking.

## Supabase
- Use `supabase migration new <name>` for schema changes.
- Use `supabase db push` to apply migrations.
- Always review generated SQL before pushing.

## GoHighLevel SDK
- Package: `@gohighlevel/api-client` (official Node.js SDK)
- Auth: Private Integration Token (PIT) via `GHL_FILE_UPLOAD_TOKEN` env var
- Singleton: `src/clients/ghlSdk.js` — import `{ ghl }` from `./ghlSdk` for the shared instance
- All GHL API calls go through the SDK. Use `ghl.contacts.*`, `ghl.opportunities.*`, `ghl.calendars.*`, `ghl.conversations.*`
- For new GHL features, check SDK method signatures in `node_modules/@gohighlevel/api-client/dist/lib/code/` — no need to look up REST endpoints manually
- 3 exceptions use raw HTTP (no SDK method): `addOpportunityNote`, `getConversationHistory` (uses `/conversations/messages/export`), `uploadFilesToTattooCustomField` (multipart FormData)
- Custom fields: v2 API uses `customFields` array `[{ id, field_value }]`, NOT v1 `customField` object. The `transformBodyForV2()` helper in `ghlClient.js` handles this automatically.
- `getContact()` returns contacts with BOTH `customField` (object) and `customFields` (array) via normalization, so callers can use either format.

## Deployment
- Backend is hosted on Render at `https://studio-az-setter-backend.onrender.com`.
- Pushes to `main` trigger automatic deploys on Render.
