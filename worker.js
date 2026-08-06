// Basketly Worker — Cloudflare. Holds your ANTHROPIC_API_KEY server-side.
// Deploy: `wrangler deploy`  |  Set key: `wrangler secret put ANTHROPIC_API_KEY`
//
// Two routes on the same worker:
//   POST  <worker-url>/          -> item routing (unchanged)
//         body { items:[...], stores:[{id,name,color}] }
//         returns [{name,stores:[ids],category}]
//   POST  <worker-url>/recipes   -> recipe ideas
//         body { ingredients, forWhom, ageBand, flavors:[], allowOneExtra }
//         returns [{name,minutes,ingredientsUsed:[],steps:[],notes,oneExtra}]

const MODEL = "claude-haiku-4-5-20251001";

// Lock this to your GitHub Pages origin in production, e.g. "https://you.github.io"
const ALLOW_ORIGIN = "*";

const CORS = {
  "Access-Control-Allow-Origin": ALLOW_ORIGIN,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });

async function callClaude(env, system, userText, maxTokens = 1400) {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: userText }],
    }),
  });
  if (!resp.ok) throw new Error("claude " + resp.status);
  const data = await resp.json();
  const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
  return text.replace(/```json/gi, "").replace(/```/g, "").trim();
}

// ---- route: item routing (unchanged behavior) ----
async function handleRoute(req, env) {
  let items = [], stores = [];
  try { ({ items = [], stores = [] } = await req.json()); }
  catch { return json({ error: "bad json" }, 400); }
  if (!items.length) return json([]);

  const ids = stores.map(s => s.id);
  const names = stores.map(s => `${s.id} (${s.name})`).join(", ");

  const system =
    `You route grocery items to stores for a household. Stores: ${names}. ` +
    `Categories (pick exactly one): Produce, Bakery, Dairy, Meat, Frozen, Spices, Staples, Household. ` +
    `For each item, list which store ids typically carry it. ` +
    `South-Asian / specialty items belong to the specialty store; add a mainstream store only if it genuinely stocks the item. ` +
    `Everyday items belong to the mainstream stores. ` +
    `Respond with ONLY a JSON array, no prose, no markdown fences: ` +
    `[{"name":"<item>","stores":[<ids>],"category":"<category>"}]`;

  let clean;
  try { clean = await callClaude(env, system, "Items:\n" + items.join("\n"), 1024); }
  catch (e) { return json({ error: String(e.message || e) }, 502); }

  let arr;
  try { arr = JSON.parse(clean); } catch { return json({ error: "parse", raw: clean }, 502); }

  const CATS = ["Produce","Bakery","Dairy","Meat","Frozen","Spices","Staples","Household"];
  const out = (Array.isArray(arr) ? arr : []).map(r => ({
    name: String(r.name || "").trim(),
    stores: (r.stores || []).filter(s => ids.includes(s)),
    category: CATS.includes(r.category) ? r.category : "Unsorted",
  })).filter(r => r.name);

  return json(out);
}

// ---- route: recipe ideas ----
const AGE_LABEL = {
  u6: "under 6 months", "6_9": "6-9 months", "9_12": "9-12 months",
  "12_18": "12-18 months", "18_36": "18-36 months",
};

async function handleRecipes(req, env) {
  let b = {};
  try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const ingredients = String(b.ingredients || "").trim();
  if (!ingredients) return json([]);
  const forWhom = ["baby","kids","adults","family"].includes(b.forWhom) ? b.forWhom : "family";
  const ageBand = b.ageBand && AGE_LABEL[b.ageBand] ? AGE_LABEL[b.ageBand] : null;
  const flavors = Array.isArray(b.flavors) ? b.flavors.filter(f => typeof f === "string") : [];
  const staples = Array.isArray(b.staples) ? b.staples.filter(s => typeof s === "string") : [];
  const mealType = ["snack","meal","soft"].includes(b.mealType) ? b.mealType : "meal";
  const cuisine = typeof b.cuisine === "string" && b.cuisine.trim() ? b.cuisine.trim() : null;
  const allowOneExtra = b.allowOneExtra !== false;

  const baby = forWhom === "baby";
  const mealLabel = mealType === "snack" ? "a quick snack" : mealType === "soft" ? "something soft and easy on sore/teething gums" : "a meal";
  const system =
    `You are a practical home-cooking helper. The user gives ingredients they have on hand. ` +
    `Suggest UP TO 5 realistic dishes they can make mostly from those ingredients. Aim for ${mealLabel}. ` +
    (cuisine ? `Prefer ${cuisine} cuisine dishes. ` : "") +
    (staples.length
      ? `The household ALWAYS has these staples on hand (assume available, don't count them as "need"): ${staples.join(", ")}. `
      : `Assume only water and cooking oil are always available. `) +
    `Also assume basic cooking heat/utensils. Prefer dishes that use several of the listed ingredients. ` +
    (baby
      ? `THIS IS FOR A BABY (${ageBand || "age not given"}). Follow infant-feeding safety strictly: ` +
        `age-appropriate texture (smooth purees for the youngest, then mashed, then soft finger foods); ` +
        `NO honey under 12 months (even if it's a staple); NO added salt or sugar; avoid choking hazards (whole nuts, whole grapes, hard raw chunks, globs of nut butter); ` +
        `keep recipes simple with few ingredients. If age is under 6 months, note solids usually have not started and keep suggestions minimal and cautious. ` +
        `Ignore any "spicy" request for a baby. In each dish's notes, include the suitable texture for this age. `
      : `Audience: ${forWhom}. `) +
    (flavors.length ? `Bias toward these flavors when sensible: ${flavors.join(", ")}. ` : "") +
    (allowOneExtra
      ? `Each dish MAY include "oneExtra": a single common ingredient (not already available) that would unlock or noticeably improve the dish, or null. `
      : `Do not suggest extra ingredients; set oneExtra to null. `) +
    `For each dish also compute "need": the array of ingredients the dish requires that are NOT among the user's listed ingredients and NOT among the household staples (empty array if they already have everything). ` +
    `Return per dish: name, minutes (integer, approx total time), ingredientsUsed (array of the user's listed ingredients it uses), steps (array of short imperative steps), need (array), notes (one short helpful note), oneExtra (string or null). ` +
    `Respond with ONLY a JSON array, no prose, no markdown fences: ` +
    `[{"name":"...","minutes":15,"ingredientsUsed":["..."],"need":[],"steps":["..."],"notes":"...","oneExtra":null}]`;

  const userText =
    `Ingredients on hand:\n${ingredients}\n\n` +
    (staples.length ? `Always-available staples: ${staples.join(", ")}\n` : "") +
    `Meal type: ${mealType}\n` + (cuisine ? `Cuisine: ${cuisine}\n` : "") +
    `For: ${forWhom}${baby && ageBand ? " (" + ageBand + ")" : ""}` +
    (flavors.length ? `\nFlavors: ${flavors.join(", ")}` : "");

  let clean;
  try { clean = await callClaude(env, system, userText, 1800); }
  catch (e) { return json({ error: String(e.message || e) }, 502); }

  let arr;
  try { arr = JSON.parse(clean); } catch { return json({ error: "parse", raw: clean }, 502); }

  const out = (Array.isArray(arr) ? arr : []).slice(0, 6).map(d => ({
    name: String(d.name || "").trim(),
    minutes: Number.isFinite(+d.minutes) ? Math.round(+d.minutes) : null,
    ingredientsUsed: Array.isArray(d.ingredientsUsed) ? d.ingredientsUsed.map(String) : [],
    need: Array.isArray(d.need) ? d.need.map(String) : [],
    steps: Array.isArray(d.steps) ? d.steps.map(String) : [],
    notes: d.notes ? String(d.notes) : "",
    oneExtra: allowOneExtra && d.oneExtra ? String(d.oneExtra) : null,
  })).filter(d => d.name);

  return json(out);
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (req.method !== "POST") return json({ error: "POST only" }, 405);
    const { pathname } = new URL(req.url);
    if (pathname.replace(/\/+$/, "").endsWith("/recipes")) return handleRecipes(req, env);
    return handleRoute(req, env);
  },
};
