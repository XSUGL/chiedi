#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// Сборка корпуса: неглубокий обход официальных сайтов по списку.
//
//   node ingest.mjs                 # собрать по sources.json
//   node ingest.mjs --max 40        # не больше сорока страниц
//
// В репозитории лежит сборщик и список адресов, а не скачанный текст.
// Так у каждой цитаты есть живой первоисточник, и корпус пересобирается
// заново, когда ведомство перепишет страницу. Чужой текст, замороженный
// в чужом гите, устареет молча и будет врать с уверенным видом.
// ═══════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf("--" + n); return i === -1 ? d : args[i + 1]; };
const MAX = Number(flag("max", 40));
const OUT = flag("out", "corpus.json");
const DELAY = Number(flag("delay", 900));      // вежливость к чужому серверу

const { seeds, keywords, deny } = JSON.parse(readFileSync("sources.json", "utf8"));
const KEEP = new RegExp(keywords.join("|"), "i");
const DENY = new RegExp(deny.join("|"), "i");

// Заголовки HTTP ходят только латиницей: кириллица в User-Agent
// роняет fetch на "Cannot convert argument to a ByteString".
const UA = "chiedi/1.0 (corpus builder; contact: yaroslavyuzvak.info)";

async function fetchPage(url) {
  const c = AbortSignal.timeout(20000);
  const res = await fetch(url, { headers: { "user-agent": UA }, signal: c, redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = res.headers.get("content-type") || "";
  if (!/text\/html/i.test(type)) throw new Error(`не HTML: ${type}`);
  return { html: await res.text(), finalUrl: res.url };
}

/** Из HTML в читаемый текст. Скрипты, стили, меню и подвалы выбрасываем. */
export function toText(html) {
  let h = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  // Заголовки и абзацы превращаем в строки: границы абзаца нужны,
  // чтобы кусок корпуса не начинался с середины предложения.
  h = h.replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
       .replace(/<br\s*\/?>/gi, "\n")
       .replace(/<[^>]+>/g, " ");
  const ent = { "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"',
                "&#39;": "'", "&rsquo;": "’", "&agrave;": "à", "&egrave;": "è",
                "&eacute;": "é", "&igrave;": "ì", "&ograve;": "ò", "&ugrave;": "ù" };
  h = h.replace(/&[a-z#0-9]+;/gi, (m) => ent[m.toLowerCase()] ?? " ");
  return h.split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim())
          .filter(Boolean).join("\n").replace(/\n{3,}/g, "\n\n");
}

const title = (html) => (html.match(/<title[^>]*>([^<]{0,200})/i) || [])[1]?.trim() || null;

/** Куски по строкам, с перекрытием: ответ часто лежит на стыке.

    Резать по пустым строкам не вышло: страница ведомства приходит
    сплошной простынёй, двойных переносов в ней почти нет, и весь
    документ становился одним куском. Границей служит строка. */
export function chunk(text, { size = 1100, overlap = 200 } = {}) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const out = [];
  let buf = "";
  for (const line of lines) {
    if (buf && buf.length + line.length > size) {
      out.push(buf.trim());
      // Перекрытие берём только с целой строки. Если последняя строка
      // длиннее перекрытия, лучше обойтись без него: кусок, начатый
      // с середины слова, и ищется хуже, и в цитате выглядит обрывком.
      const tail = buf.slice(-overlap);
      const nl = tail.indexOf("\n");
      buf = nl === -1 ? "" : tail.slice(nl + 1);
    }
    buf += (buf ? "\n" : "") + line;
  }
  if (buf.trim().length > 80) out.push(buf.trim());
  return out.filter((c) => c.length > 200);      // огрызки не несут смысла
}

/** Выбросить то, что повторяется на всех страницах сайта.

    Меню, хлебные крошки и подвал приходят в тексте каждой страницы
    и весят больше, чем сама страница. Ловить их правилами под
    конкретный сайт бессмысленно: следующий сайт сверстан иначе.
    Зато они отличаются тем, что повторяются. Строка, встреченная
    больше чем на трети страниц, это обвязка, а не содержание. */
export function dropBoilerplate(docs, share = 0.34) {
  const freq = new Map();
  for (const d of docs)
    for (const line of new Set(d.text.split("\n")))
      freq.set(line, (freq.get(line) || 0) + 1);

  const limit = Math.max(2, Math.ceil(docs.length * share));
  const common = new Set([...freq].filter(([l, n]) => n >= limit && l.length < 120).map(([l]) => l));

  for (const d of docs)
    d.text = d.text.split("\n").filter((l) => !common.has(l.trim())).join("\n");

  return { removed: common.size, limit };
}

// ── обход ────────────────────────────────────────────────────────
const seen = new Set(), queue = [...seeds], docs = [];
let visited = 0;

while (queue.length && docs.length < MAX) {
  const url = queue.shift();
  const clean = url.split("#")[0].replace(/\/$/, "");
  if (seen.has(clean)) continue;
  seen.add(clean);

  let page;
  try { page = await fetchPage(url); }
  catch (e) { console.log(`   ✗ ${url.slice(0, 70)} ${e.message}`); continue; }
  visited++;

  const text = toText(page.html);
  const t = title(page.html);
  const relevant = KEEP.test(url) || KEEP.test(t || "") || KEEP.test(text.slice(0, 1500));

  if (relevant && text.length > 800) {
    docs.push({ url: page.finalUrl, title: t, text });
    console.log(`   ✓ ${(t || page.finalUrl).slice(0, 62).padEnd(62)} ${Math.round(text.length / 1024)} КБ`);
  }

  // Ссылки того же домена, похожие по теме: обход неглубокий и узкий.
  const host = new URL(page.finalUrl).host;
  for (const m of page.html.matchAll(/<a[^>]+href=["']([^"'#]+)["']/gi)) {
    let next;
    try { next = new URL(m[1], page.finalUrl); } catch { continue; }
    if (next.host !== host || !/^https?:/.test(next.protocol)) continue;
    if (DENY.test(next.href) || /\.(pdf|zip|jpg|png|doc|xls)/i.test(next.pathname)) continue;
    if (!KEEP.test(next.href)) continue;
    if (!seen.has(next.href.split("#")[0].replace(/\/$/, ""))) queue.push(next.href);
  }
  await new Promise((r) => setTimeout(r, DELAY));
}

const before = docs.reduce((a, d) => a + d.text.length, 0);
const { removed, limit } = dropBoilerplate(docs);
const after = docs.reduce((a, d) => a + d.text.length, 0);
console.log(`\n   Обвязка: выброшено ${removed} строк, встречавшихся на ${limit}+ страницах из ${docs.length}.`);
console.log(`   Текста было ${Math.round(before / 1024)} КБ, осталось ${Math.round(after / 1024)} КБ ` +
            `(${Math.round((1 - after / before) * 100)}% было меню и подвалом).`);

const chunks = docs.flatMap((d, di) =>
  chunk(d.text).map((text, ci) => ({ id: `${di}:${ci}`, url: d.url, title: d.title, text })));

writeFileSync(OUT, JSON.stringify({ built: new Date().toISOString(), docs: docs.length,
                                    chunks: chunks.length, items: chunks }, null, 1));
console.log(`\n📄 ${OUT}: ${docs.length} страниц, ${chunks.length} кусков (обошли ${visited})\n`);
