// api/summarize.js — Vercel serverless function.
// Holds the Anthropic API key server-side so it is never exposed to the browser.

const MODEL = "claude-sonnet-4-6";

function buildPrompt(mode, payload) {
  const today = new Date().toISOString();
  if (mode === "important") {
    return `Today is ${today}. Below is JSON metadata for emails in my Gmail inbox (promotions/social already excluded).
Pick up to 6 that contain genuinely important information I should personally address: bills or payments due, security or fraud alerts, government/DMV/military notices, travel itineraries or flight changes, personal messages from real people, deadlines, account problems. EXCLUDE newsletters, marketing, and routine statements.
Emails: ${JSON.stringify(payload.emails)}
Respond ONLY with minified JSON, no other text:
[{"id":"<threadId>","from":"<short sender name>","subject":"<subject>","note":"<one short sentence: what it is and what to do>","date":"<ISO date>"}]
If nothing qualifies, respond [].`;
  }
  if (mode === "digest") {
    return `Today is ${today}. Below is JSON metadata for emails in my Gmail inbox.
Identify only NEWSLETTER / news-digest emails (tech, finance, defense, local news publications). Ignore retail promos and transactional mail.
Bucket by age relative to today: "h24" = under 24 hours, "week" = 1-7 days, "older" = over 7 days. Max 5 items per bucket, newest first.
For each, write a one-line highlight of its key stories from the subject and snippet.
Emails: ${JSON.stringify(payload.emails)}
Respond ONLY with minified JSON, no other text:
{"h24":[{"id":"<threadId>","src":"<publication>","hl":"<one-line highlight>","date":"<ISO>"}],"week":[...],"older":[...]}`;
  }
  if (mode === "subs") {
    return `Below are groups of promotional/subscription emails from my inbox, grouped by sender, with sample subjects.
For each group, write one short sentence describing what this sender typically sends.
Groups: ${JSON.stringify(payload.groups)}
Respond ONLY with minified JSON mapping sender email to summary, no other text:
{"<email>":"<one short sentence>", ...}`;
  }
  throw new Error("Unknown mode");
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "ANTHROPIC_API_KEY is not configured" });
    return;
  }
  try {
    const { mode, payload } = req.body || {};
    const prompt = buildPrompt(mode, payload || {});
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1500,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await r.json();
    if (data.error) {
      res.status(502).json({ error: data.error.message || "Anthropic error" });
      return;
    }
    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .replace(/```json|```/g, "")
      .trim();
    const starts = ["{", "["].map((c) => text.indexOf(c)).filter((i) => i !== -1);
    if (!starts.length) {
      res.status(502).json({ error: "Model returned no JSON" });
      return;
    }
    const start = Math.min(...starts);
    const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
    res.status(200).json(JSON.parse(text.slice(start, end + 1)));
  } catch (e) {
    res.status(500).json({ error: e.message || "Server error" });
  }
}
