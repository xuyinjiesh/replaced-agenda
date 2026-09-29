const NAMED = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–",
  hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", middot: "·", times: "×",
  laquo: "«", raquo: "»", deg: "°", copy: "©", reg: "®", trade: "™", bull: "•", prime: "′",
};

export function decodeEntities(input = "") {
  return String(input)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => NAMED[name] ?? NAMED[name.toLowerCase()] ?? m);
}

function safeCodePoint(cp) {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return "";
  try {
    return String.fromCodePoint(cp);
  } catch {
    return "";
  }
}

export function stripTags(html = "") {
  return decodeEntities(
    String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<\/p>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  );
}

export function collapseWhitespace(s = "") {
  return String(s).replace(/\s+/g, " ").trim();
}

export function cleanText(s = "") {
  return collapseWhitespace(stripTags(s));
}

export function truncate(s, max) {
  const str = String(s ?? "");
  if (str.length <= max) return str;
  return `${str.slice(0, max - 1).trimEnd()}…`;
}

const STOPWORDS = new Set(
  `a an the and or but if then than that this these those of in on at to for from by with without into over under
   is are was were be been being do does did done have has had will would can could should may might must not no
   we our you your they their it its he she his her as about after before during between out up down off again
   more most other some such only own same so too very s t just now new using used use based via toward towards
   study studies paper results show shows propose proposed approach method methods model models data`
    .split(/\s+/)
    .filter(Boolean),
);

export function tokenize(s = "") {
  return collapseWhitespace(String(s).toLowerCase())
    .replace(/[^a-z0-9\u4e00-\u9fff\s-]/g, " ")
    .split(/\s+/)
    .map((t) => t.replace(/^-+|-+$/g, ""))
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

export function normalizeTitle(s = "") {
  return collapseWhitespace(
    String(s)
      .toLowerCase()
      .replace(/[\u2018\u2019\u201c\u201d"']/g, "")
      .replace(/[^a-z0-9\u4e00-\u9fff\s]/g, " ")
      .replace(/\b(a|an|the|of|on|in|for|and|to|with|by)\b/g, " "),
  );
}

function fnv1a64(str, seed = 0xcbf29ce484222325n) {
  let h = BigInt.asUintN(64, seed);
  const prime = 0x100000001b3n;
  for (let i = 0; i < str.length; i += 1) {
    h ^= BigInt(str.charCodeAt(i));
    h = BigInt.asUintN(64, h * prime);
  }
  return h;
}

export function shingles(tokens, k = 3) {
  if (tokens.length <= k) return new Set(tokens);
  const out = new Set();
  for (let i = 0; i + k <= tokens.length; i += 1) out.add(tokens.slice(i, i + k).join(" "));
  return out;
}

export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

export function simhash(tokens, bits = 64) {
  const v = new Array(bits).fill(0);
  for (const token of tokens) {
    const h = fnv1a64(token);
    for (let i = 0; i < bits; i += 1) {
      const bit = (h >> BigInt(i)) & 1n;
      v[i] += bit === 1n ? 1 : -1;
    }
  }
  let out = 0n;
  for (let i = 0; i < bits; i += 1) if (v[i] > 0) out |= 1n << BigInt(i);
  return out;
}

export function hamming(a, b) {
  let x = a ^ b;
  let count = 0;
  while (x > 0n) {
    x &= x - 1n;
    count += 1;
  }
  return count;
}

export function canonicalUrl(raw = "") {
  if (!raw) return "";
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    return String(raw).trim().toLowerCase();
  }
  u.hash = "";
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
  u.protocol = "https:";
  const drop = [];
  for (const k of [...u.searchParams.keys()]) {
    if (/^(utm_|ref$|ref_|source$|fbclid|gclid|mc_cid|mc_eid|igshid|spm|from$|share)/i.test(k)) drop.push(k);
  }
  for (const k of drop) u.searchParams.delete(k);
  u.searchParams.sort();
  let pathname = u.pathname.replace(/\/+$/, "");
  if (!pathname) pathname = "/";
  // arXiv 的 abs/pdf/版本号归一
  pathname = pathname.replace(/^\/(abs|pdf)\//, "/abs/").replace(/v\d+$/, "");
  u.pathname = pathname;
  return u.toString();
}

export function slugify(s = "") {
  return (
    String(s)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "item"
  );
}

export function escapeHtml(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 从模型输出里抽取第一个平衡的 JSON 对象/数组。 */
export function extractJSON(text) {
  const s = String(text ?? "");
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : s;
  const start = body.search(/[[{]/);
  if (start === -1) return null;
  const open = body[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < body.length; i += 1) {
    const c = body[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(body.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}