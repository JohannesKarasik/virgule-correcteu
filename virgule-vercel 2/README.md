# Virgule — correcteur de virgules

## Deploy
1. Push this folder to a GitHub repo (or run `vercel` inside it).
2. In Vercel → Project → Settings → Environment Variables, add:
   - `OPENAI_API_KEY` (required)
   - `OPENAI_MODEL` (optional, default `gpt-4.1-mini`)
3. Deploy. No build step needed.

## Structure
- `index.html` — the editor (highlights, popover, accept/ignore)
- `api/check.js` — POST /api/check: gets a corrected version of the text from OpenAI,
  diffs it against the original and returns every difference with its position.
