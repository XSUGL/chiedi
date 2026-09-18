#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// Ответ по корпусу, с обязательной ссылкой на источник.
//
//   node answer.mjs "che cos'è il fascicolo d'impresa"
//   node answer.mjs --min 9.76 "..."     # порог отказа из eval.mjs
//   node answer.mjs --show "..."         # показать найденные куски
//
// Доступ: export FREE_API_KEY="..."  (console.groq.com, бесплатно)
//     или export ANTHROPIC_API_KEY="sk-ant-..."
//
// Два правила, ради которых всё и написано:
//   модель отвечает только тем, что лежит в найденных кусках;
//   если куски слабые, она не отвечает вовсе.
// ═══════════════════════════════════════════════════════════════

import { readFileSync } from "node:fs";
import { buildIndex, search } from "./search.mjs";

const args = process.argv.slice(2);
const has = (n) => args.includes("--" + n);
const flag = (n, d) => { const i = args.indexOf("--" + n); return i === -1 ? d : args[i + 1]; };
const question = args.filter((a, i) => !a.startsWith("--") && !String(args[i - 1] || "").startsWith("--")).join(" ").trim();

if (!question) {
  console.error(`\nСпроси что-нибудь:\n   node answer.mjs "che cos'è il SUAP"\n`);
  process.exit(1);
}

// Порог и мера приходят из eval.mjs, а не из головы. Мера не сырой вес
// нарочно: он растёт с длиной вопроса, и короткий "Che cos'è il SUAP?"
// получал отказ на корпусе, который весь про SUAP.
const BY = flag("by", "perTerm");
const MIN = Number(flag("min", 1.14));
const K = Number(flag("k", 4));

const FREE_KEY = process.env.FREE_API_KEY || process.env.GROQ_API_KEY;
const FREE_URL = process.env.FREE_BASE_URL || "https://api.groq.com/openai/v1";
const FREE_MODEL = process.env.FREE_MODEL || "openai/gpt-oss-20b";
const ANT_KEY = process.env.ANTHROPIC_API_KEY;

const { items } = JSON.parse(readFileSync(flag("corpus", "corpus.json"), "utf8"));
const hits = search(buildIndex(items), question, K);
const best = hits[0]?.[BY] ?? 0;

console.log(`\n▸ ${question}`);
if (has("show")) for (const h of hits)
  console.log(`\n   [вес ${h.score.toFixed(2)} · на слово ${h.perTerm.toFixed(2)} · покрытие ${(h.coverage * 100).toFixed(0)}%] ${h.url}\n   ${h.text.slice(0, 200).replace(/\n/g, " ")}…`);

// ── отказ ────────────────────────────────────────────────────────
// Здесь заканчивается большинство таких систем: дальше они всё равно
// зовут модель, та отвечает из головы, и ответ выглядит ровно так же
// убедительно, как настоящий. Поэтому отказ стоит раньше вызова.
if (best < MIN) {
  console.log(`\n   В корпусе про это ничего нет (${BY} лучшего куска ${best.toFixed(2)}, порог ${MIN}).`);
  console.log(`   Отвечать не буду: выдуманный ответ со ссылкой на ведомство хуже молчания.`);
  if (hits.length) console.log(`\n   Ближайшее, что нашлось: ${hits[0].url}`);
  console.log();
  process.exit(0);
}

const context = hits.map((h, i) => `[${i + 1}] ${h.title}\n${h.url}\n\n${h.text}`).join("\n\n———\n\n");

const SYSTEM = `Ты отвечаешь на вопросы предпринимателей по официальным документам.

Тебе дают куски страниц ведомств. Отвечай ТОЛЬКО тем, что в них написано.

Правила:
- Каждое утверждение сопровождай номером куска в квадратных скобках: [1], [2].
- Если в кусках нет ответа, так и скажи. Не достраивай из общих знаний.
- Не обобщай: если написано про один случай, не переноси на все.
- Отвечай на языке вопроса, коротко, деловым тоном, без вступлений.
- Ты не юрист и не консультант. Если вопрос про сроки, деньги или
  ответственность, добавь строкой, что проверить нужно на самой странице.`;

const prompt = `ВОПРОС\n${question}\n\nКУСКИ ДОКУМЕНТОВ\n\n${context}`;

let text;
if (FREE_KEY) {
  const res = await fetch(`${FREE_URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${FREE_KEY}` },
    body: JSON.stringify({ model: FREE_MODEL, temperature: 0,
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: prompt }] }),
  });
  if (!res.ok) { console.error(`\n❌ ${FREE_URL}: HTTP ${res.status}\n`); process.exit(1); }
  text = (await res.json()).choices?.[0]?.message?.content || "";
} else if (ANT_KEY) {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const res = await new Anthropic().messages.create({
    model: flag("model", "claude-opus-5"), max_tokens: 2000,
    thinking: { type: "adaptive" },
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: prompt }],
  });
  text = res.content.filter((c) => c.type === "text").map((c) => c.text).join("");
} else {
  console.error(`\n❌ Нужен ключ: export FREE_API_KEY="..." (бесплатно, console.groq.com)\n`);
  process.exit(1);
}

console.log(`\n${text.trim()}\n`);
console.log(`   Источники:`);
hits.forEach((h, i) => console.log(`   [${i + 1}] ${h.url}`));
console.log();
