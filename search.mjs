// ═══════════════════════════════════════════════════════════════
// Поиск по корпусу: BM25, без модели и без эмбеддингов.
//
// Так нарочно. Половину проекта, которую нужно измерять, можно
// измерять бесплатно и повторяемо: у BM25 нет ключа, нет тарифа
// и нет случайности. Если потом добавить эмбеддинги, станет видно,
// на сколько именно они улучшили recall, а не "стало лучше".
// ═══════════════════════════════════════════════════════════════

// Итальянские служебные слова: они есть в каждом документе и только
// шумят. Список короткий нарочно, длинный выкидывает смысл.
const STOP = new Set(`il lo la i gli le un uno una di a da in con su per tra fra
e o ma se che chi cui non piu meno come dove quando quale quali questo questa
questi queste quel quello quella al allo alla ai agli alle dal dallo dalla dai
dagli dalle del dello della dei degli delle nel nello nella nei negli nelle sul
sullo sulla sui sugli sulle col coi essere sono stato stata essere ha hanno
anche sia siano puo possono deve devono essere e' inoltre ovvero nonche`.split(/\s+/));

/** Слова в нижнем регистре, без хвостовых окончаний.
    Полноценный стеммер тут был бы лишним: нам нужно, чтобы
    "impresa" находило "imprese", а не морфология итальянского. */
export function tokens(s) {
  return String(s).toLowerCase()
    .replace(/[’']/g, " ")
    .split(/[^a-zà-ÿ0-9]+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .map((w) => w.replace(/(zioni|zione|mento|menti|ità|ita|are|ere|ire|ati|ate|ito|ita|che|chi|i|e|a|o)$/u, ""))
    .filter((w) => w.length > 2);
}

export function buildIndex(items) {
  const docs = items.map((it) => ({ ...it, terms: tokens(it.title + " " + it.text) }));
  const df = new Map();
  for (const d of docs) for (const t of new Set(d.terms)) df.set(t, (df.get(t) || 0) + 1);
  const avg = docs.reduce((a, d) => a + d.terms.length, 0) / (docs.length || 1);
  return { docs, df, avg, N: docs.length };
}

/** BM25 с обычными k1 и b. Заголовок весит чуть больше текста:
    на страницах ведомств он и есть название процедуры. */
export function search(index, query, k = 5) {
  const { docs, df, avg, N } = index;
  const q = tokens(query);
  const k1 = 1.5, b = 0.75;

  const scored = docs.map((d) => {
    const tf = new Map();
    for (const t of d.terms) tf.set(t, (tf.get(t) || 0) + 1);
    const titleTerms = new Set(tokens(d.title || ""));

    let score = 0;
    for (const t of q) {
      const f = tf.get(t);
      if (!f) continue;
      const idf = Math.log(1 + (N - df.get(t) + 0.5) / (df.get(t) + 0.5));
      const norm = f * (k1 + 1) / (f + k1 * (1 - b + b * d.terms.length / avg));
      score += idf * norm * (titleTerms.has(t) ? 1.35 : 1);
    }
    return { ...d, score };
  });

  const top = scored.filter((d) => d.score > 0).sort((a, b) => b.score - a.score).slice(0, k);

  // Сырой вес BM25 растёт с длиной вопроса: у суммы больше слагаемых.
  // Порог по нему наказывает короткие вопросы - "Che cos'è il SUAP?"
  // получал отказ на корпусе, который весь про SUAP. Поэтому рядом
  // считаем две величины, от длины не зависящие:
  //   coverage - какая доля слов вопроса вообще нашлась в куске;
  //   perTerm  - вес в пересчёте на слово запроса.
  const uniq = [...new Set(q)];
  for (const d of top) {
    const has = new Set(d.terms);
    d.coverage = uniq.length ? uniq.filter((t) => has.has(t)).length / uniq.length : 0;
    d.perTerm = uniq.length ? d.score / uniq.length : 0;
  }
  return top;
}
