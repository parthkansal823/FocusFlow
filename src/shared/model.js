// A tiny on-device text classifier (Naive Bayes over words and word pairs).
// Trained in the browser from bundled examples, the LLM's verdicts and the
// user's own corrections. No network, no API key.

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "on", "in", "of", "to", "is", "by", "at", "as", "or", "an",
  "this", "that", "you", "your", "are", "was", "how", "what", "why", "who", "its", "it's", "into",
  "all", "new", "out", "one", "has", "have", "can", "not", "but", "our", "will", "his", "her", "they", "them", "then", "than", "about", "just", "get",
  "com", "www", "org", "net", "html", "php", "https", "http", "watch", "youtube",
  "ka", "ki", "ke", "hai", "se", "me", "mein", "aur", "ko", "ek", "kya", "ye", "wo", "bhi"
]);

export const LABELS = ["study", "distraction"];

export function tokenize(text) {
  const words = String(text || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/c\+\+/g, " cplusplus ")
    .replace(/c#/g, " csharp ")
    .replace(/\.net\b/g, " dotnet ")
    .replace(/node\.js/g, " nodejs ")
    .split(/[^\p{L}\p{N}\p{M}]+/u)
    .filter(w => w.length > 1 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
  const tokens = new Set(words);
  for (let i = 0; i < words.length - 1; i++) tokens.add(`${words[i]}_${words[i + 1]}`);
  return [...tokens];
}

/**
 * @param {{text: string, label: "study"|"distraction", weight?: number}[]} examples
 */
export function trainModel(examples) {
  const model = {
    docs: { study: 0, distraction: 0 },
    total: { study: 0, distraction: 0 },
    counts: new Map()
  };
  for (const { text, label, weight = 1 } of examples) {
    if (!LABELS.includes(label)) continue;
    model.docs[label] += weight;
    for (const token of tokenize(text)) {
      let count = model.counts.get(token);
      if (!count) {
        count = { study: 0, distraction: 0 };
        model.counts.set(token, count);
      }
      count[label] += weight;
      model.total[label] += weight;
    }
  }
  return model;
}

/**
 * @returns {{pStudy: number, known: number, signals: {token: string, weight: number}[]}}
 *   pStudy is 0.5 when the text has no words the model knows.
 */
export function predict(model, text) {
  const vocab = model.counts.size || 1;
  const alpha = 1;
  const signals = [];
  let logit = 0; // equal priors: the bundled data is balanced on purpose
  for (const token of tokenize(text)) {
    const count = model.counts.get(token);
    if (!count) continue;
    const pStudy = (count.study + alpha) / (model.total.study + alpha * vocab);
    const pDistraction = (count.distraction + alpha) / (model.total.distraction + alpha * vocab);
    const weight = Math.log(pStudy / pDistraction);
    logit += weight;
    signals.push({ token: token.replace(/_/g, " "), weight });
  }
  signals.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
  return { pStudy: 1 / (1 + Math.exp(-logit)), known: signals.length, signals };
}
