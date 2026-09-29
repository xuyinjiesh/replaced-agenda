/**
 * 证据片段核对：确认 AI 给出的 evidence_quote 确实逐字来自原文，
 * 这是防止模型编造引文的关键闸门。
 */

function canon(s = "") {
  return String(s)
    .replace(/\s+/g, " ")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[–—]/g, "-")
    .trim()
    .toLowerCase();
}

export function canonicalEvidenceCheck(quote, item) {
  const q = canon(quote);
  if (!q) return { verified: false, ratio: 0, quote: "" };

  const haystackRaw = [item.title, item.summary].filter(Boolean).join(" \n ");
  const haystack = canon(haystackRaw);

  if (haystack.includes(q)) {
    // 用原文大小写还原引文，保证写入 JSON 的是真原文
    const idx = haystack.indexOf(q);
    const restored = haystackRaw.replace(/\s+/g, " ").slice(idx, idx + q.length);
    return { verified: true, ratio: 1, quote: restored.trim() };
  }

  // 允许轻微出入：以 12 字的滑动窗口计算覆盖率
  const win = 12;
  if (q.length < win) return { verified: false, ratio: 0, quote: "" };
  let hits = 0;
  let total = 0;
  for (let i = 0; i + win <= q.length; i += win) {
    total += 1;
    if (haystack.includes(q.slice(i, i + win))) hits += 1;
  }
  const ratio = total ? hits / total : 0;
  if (ratio >= 0.8) {
    // 大部分能对上：截取最长可核对片段作为引文，避免写入模型改写的文字
    const longest = longestMatchingRun(q, haystack);
    if (longest.length >= 40) return { verified: true, ratio, quote: longest };
  }
  return { verified: false, ratio, quote: "" };
}

function longestMatchingRun(q, haystack) {
  let best = "";
  let lo = 0;
  let hi = q.length;
  // 二分找最长可匹配前缀长度（近似：逐段扩展）
  const matches = (len) => {
    for (let i = 0; i + len <= q.length; i += 1) if (haystack.includes(q.slice(i, i + len))) return q.slice(i, i + len);
    return null;
  };
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const found = matches(mid);
    if (found) {
      best = found;
      lo = mid;
    } else hi = mid - 1;
  }
  return best.trim();
}