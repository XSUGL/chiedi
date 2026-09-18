#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// Замер поиска. Без модели, без ключа, без денег.
//
//   node eval.mjs              # recall@k, MRR и граница отказа
//   node eval.mjs --verbose    # показать промахи
//
// Меряется две вещи, и вторая важнее первой:
//   1. находит ли поиск нужную страницу (recall@1/3/5, MRR);
//   2. отличает ли он вопрос, ответа на который в корпусе нет.
// Система, которая уверенно отвечает на второе, опаснее той,
// которая молчит: врать со ссылкой хуже, чем не ответить.
// ═══════════════════════════════════════════════════════════════

import { readFileSync } from "node:fs";
import { buildIndex, search } from "./search.mjs";

const args = process.argv.slice(2);
const has = (n) => args.includes("--" + n);
const flag = (n, d) => { const i = args.indexOf("--" + n); return i === -1 ? d : args[i + 1]; };

const { items, docs, built } = JSON.parse(readFileSync(flag("corpus", "corpus.json"), "utf8"));
const set = JSON.parse(readFileSync(flag("questions", "questions.json"), "utf8"));
const index = buildIndex(items);

console.log(`\nКорпус:    ${docs} страниц, ${items.length} кусков, собран ${built.slice(0, 10)}`);
console.log(`Вопросов:  ${set.answerable.length} с ответом, ${set.unanswerable.length} без\n`);

// ── находит ли нужную страницу ───────────────────────────────────
const K = 5;
let hit1 = 0, hit3 = 0, hit5 = 0, mrr = 0;
const misses = [];

for (const { q, source } of set.answerable) {
  const hits = search(index, q, K);
  const rank = hits.findIndex((h) => h.url.includes(source)) + 1;   // 0 = не нашлось
  if (rank === 1) hit1++;
  if (rank && rank <= 3) hit3++;
  if (rank && rank <= 5) hit5++;
  if (rank) mrr += 1 / rank; else misses.push({ q, source, got: hits[0]?.url.split("/").pop() });
}

const n = set.answerable.length;
const pc = (x) => `${String(Math.round(x / n * 100)).padStart(3)}%`;
console.log(`   recall@1   ${pc(hit1)}   ${hit1}/${n}   нужная страница сразу первой`);
console.log(`   recall@3   ${pc(hit3)}   ${hit3}/${n}`);
console.log(`   recall@5   ${pc(hit5)}   ${hit5}/${n}`);
console.log(`   MRR        ${(mrr / n).toFixed(3)}`);

if (misses.length && has("verbose")) {
  console.log(`\n   Промахи:`);
  for (const m of misses) console.log(`     ждали ${m.source}, получили ${m.got || "ничего"}\n       ${m.q}`);
}

// ── отличает ли вопрос без ответа ────────────────────────────────
// Если у лучшего куска низкий вес, значит в корпусе про это ничего
// нет. Порог не выдумываем: смотрим, как разошлись две группы,
// и берём середину между ними.
// Сравниваем три величины честно, а не выбираем ту, что лучше выглядит.
const METRICS = {
  "сырой вес":   (h) => h?.score ?? 0,
  "вес на слово": (h) => h?.perTerm ?? 0,
  "покрытие":     (h) => h?.coverage ?? 0,
};
const first = (q) => search(index, q, 1)[0] ?? null;
const topHit = new Map([...set.answerable, ...set.unanswerable].map((x) => [x.q, first(x.q)]));

console.log(`\n   Чем отличать вопрос без ответа:`);
let winner = null;
for (const [label, fn] of Object.entries(METRICS)) {
  const g = set.answerable.map((x) => fn(topHit.get(x.q)));
  const b = set.unanswerable.map((x) => fn(topHit.get(x.q)));
  let best = { t: 0, right: -1 };
  for (const t of [...g, ...b].sort((a, b) => a - b)) {
    const right = g.filter((v) => v >= t).length + b.filter((v) => v < t).length;
    if (right > best.right) best = { t, right };
  }
  const total = g.length + b.length;
  console.log(`     ${label.padEnd(14)} порог ${best.t.toFixed(2).padStart(5)}  верных решений ${best.right}/${total}` +
              `   (с ответом ${Math.min(...g).toFixed(2)}-${Math.max(...g).toFixed(2)}, без ${Math.min(...b).toFixed(2)}-${Math.max(...b).toFixed(2)})`);
  // При равном счёте берём меру, не зависящую от длины вопроса:
  // покрытие и вес на слово одинаковы для короткого и длинного вопроса,
  // а сырой вес у короткого всегда ниже просто потому, что слагаемых меньше.
  const better = !winner || best.right > winner.best.right
              || (best.right === winner.best.right && label !== "сырой вес" && winner.label === "сырой вес");
  if (better) winner = { label, fn, best };
}

const top = (q) => winner.fn(topHit.get(q));
const good = set.answerable.map((x) => top(x.q)).sort((a, b) => a - b);
const bad = set.unanswerable.map((x) => top(x.q)).sort((a, b) => a - b);
console.log(`\n   Побеждает «${winner.label}».`);

const lowGood = good[0], highBad = bad[bad.length - 1];
const best = winner.best;
const total = set.answerable.length + set.unanswerable.length;
const answered = set.answerable.filter((x) => top(x.q) >= best.t).length;
const refused = set.unanswerable.filter((x) => top(x.q) < best.t).length;

console.log(`\n   Порог отказа ${best.t.toFixed(2)}: ${best.right}/${total} решений верны`);
console.log(`     ответили, где ответ есть:   ${answered}/${set.answerable.length}`);
console.log(`     промолчали, где ответа нет: ${refused}/${set.unanswerable.length}`);

if (lowGood > highBad) {
  console.log(`\n   Группы разошлись полностью: ${highBad.toFixed(2)} < ${lowGood.toFixed(2)}.`);
  console.log(`   Любой порог между ними отделяет «знаю» от «не знаю» без ошибок.`);
} else {
  console.log(`\n   Группы перекрываются: есть вопрос без ответа с весом ${highBad.toFixed(2)},`);
  console.log(`   выше самого слабого вопроса с ответом (${lowGood.toFixed(2)}). Порог придётся`);
  console.log(`   выбирать, чем жертвовать: молчанием там, где ответ есть, или выдумкой там, где нет.`);
}
console.log(`\n   Порог для answer.mjs: --by ${winner.label === "покрытие" ? "coverage" : winner.label === "вес на слово" ? "perTerm" : "score"} --min ${best.t.toFixed(2)}\n`);
