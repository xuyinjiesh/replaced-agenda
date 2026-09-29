import { jaccard, hamming, normalizeTitle, shingles, simhash, tokenize } from "./text.mjs";
import { groupBy, log } from "./util.mjs";

function signature(item) {
  const titleTokens = tokenize(normalizeTitle(item.title));
  const bodyTokens = tokenize(item.summary.slice(0, 600));
  return {
    titleShingles: shingles(titleTokens, 2),
    titleTokens: new Set(titleTokens),
    bodySimhash: simhash(bodyTokens),
    bodyTokens: new Set(bodyTokens),
  };
}

/**
 * 规则相似度：标题 2-gram Jaccard + 正文 SimHash。
 * 同一篇 arXiv 论文被 cross-list 到多个分类时会在这里被识别。
 */
export function similarity(a, b, cfg) {
  const titleJac = jaccard(a.sig.titleShingles, b.sig.titleShingles);
  const tokenJac = jaccard(a.sig.titleTokens, b.sig.titleTokens);
  const ham = hamming(a.sig.bodySimhash, b.sig.bodySimhash);
  const bodyJac = jaccard(a.sig.bodyTokens, b.sig.bodyTokens);
  const sameSource = a.canonicalUrl === b.canonicalUrl;
  const titleHit = titleJac >= (cfg.titleJaccard ?? 0.72);
  const simhashHit = ham <= (cfg.simhashHamming ?? 3) && tokenJac >= 0.34;
  const bodyHit = bodyJac >= 0.6;
  return {
    sameSource,
    titleJac,
    tokenJac,
    bodyJac,
    hamming: ham,
    isDuplicate: sameSource || titleHit || simhashHit || bodyHit,
    // 灰区：规则拿不准，交给 AI 复核
    isGray: !sameSource && !titleHit && !simhashHit && !bodyHit && tokenJac >= 0.22 && tokenJac < 0.34,
    score: Math.max(titleJac, tokenJac * 0.9, bodyJac * 0.85),
  };
}

/** 并查集聚类。 */
function cluster(items, cfg) {
  const parent = items.map((_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  const grayPairs = [];
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      // 先用首词桶粗筛，避免 O(n^2) 全量比较
      const sim = similarity(items[i], items[j], cfg);
      if (sim.isDuplicate) union(i, j);
      else if (sim.isGray) grayPairs.push([i, j, sim]);
    }
  }
  const groups = new Map();
  for (let i = 0; i < items.length; i += 1) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  }
  return { clusters: [...groups.values()], grayPairs };
}

function bucketKey(item) {
  const tokens = tokenize(normalizeTitle(item.title)).filter((t) => t.length > 3);
  return tokens.slice(0, 3).sort().join("|") || item.id;
}

/**
 * 相似内容合并：同一事件的多条来源合成一条，保留信息最全的一条为主记录，
 * 其余记为 also_reported_by（这本身也是可信度信号）。
 */
export function dedupe(items, cfg = {}) {
  const prepared = items.map((it) => ({ ...it, sig: signature(it) }));

  // 分桶后分别聚类：只有共享关键词的条目才可能重复
  const buckets = groupBy(prepared, bucketKey);
  const clusters = [];
  const grayPairs = [];
  for (const [, bucket] of buckets) {
    if (bucket.length === 1) {
      clusters.push([bucket[0]]);
      continue;
    }
    // 加一个按标题首词宽松分桶的补充：用标题前 2 个词
    const sub = groupBy(bucket, (it) =>
      tokenize(normalizeTitle(it.title))
        .filter((t) => t.length > 3)
        .slice(0, 2)
        .sort()
        .join("|"),
    );
    for (const [, group] of sub) {
      const { clusters: cs, grayPairs: gp } = cluster(group, cfg);
      for (const c of cs) clusters.push(c.map((i) => group[i]));
      grayPairs.push(...gp);
    }
  }

  const merged = clusters.map((members) => {
    const sorted = [...members].sort(
      (a, b) => sourceRank(a) - sourceRank(b) || b.summary.length - a.summary.length,
    );
    const primary = sorted[0];
    const others = sorted.slice(1);
    return {
      ...primary,
      alsoReportedBy: others.map((o) => ({
        source: o.sourceName,
        url: o.url,
        title: o.title,
      })),
      mergedTitles: others.map((o) => o.title),
      clusterSize: sorted.length,
    };
  });

  log(
    "info",
    `去重合并：${items.length} → ${merged.length} 条（合并掉 ${items.length - merged.length} 条重复）`,
    grayPairs.length ? `另有 ${grayPairs.length} 对灰区待 AI 复核` : undefined,
  );
  return { merged, grayPairs, prepared };
}

/** 来源优先级：独立/高可信来源优先作为主记录。 */
const SOURCE_RANK = {
  "third_party": 0,
  journal: 1,
  research: 2,
  benchmark: 3,
  government: 3,
  "ai-lab": 4,
  media: 5,
  engineering: 5,
  policy: 5,
  newsletter: 6,
  practitioner: 6,
  community: 8,
};

function sourceRank(item) {
  return SOURCE_RANK[item.sourceGroup] ?? 6;
}

/** 统计每个来源对当日结果的贡献，用于前端展示多样性。 */
export function sourceStats(events) {
  const map = new Map();
  for (const e of events) {
    const k = e.source_name ?? "unknown";
    map.set(k, (map.get(k) ?? 0) + 1);
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]).map(([source, count]) => ({ source, count }));
}

/**
 * 应用 AI 灰区复核结果：把判定为同一事件的条目合成一条。
 * decisions: [{ i, j, keep }]，i/j 为数组下标，keep 为保留的主记录下标。
 */
export function applyMergeDecisions(items, decisions) {
  if (!decisions?.length) return { merged: items, mergedCount: 0 };
  const parent = items.map((_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const preferred = new Map();
  for (const d of decisions) {
    if (d.i >= items.length || d.j >= items.length) continue;
    preferred.set(d.i, d.keep);
    preferred.set(d.j, d.keep);
  }
  for (const d of decisions) {
    if (d.i >= items.length || d.j >= items.length) continue;
    const ri = find(d.i);
    const rj = find(d.j);
    if (ri === rj) continue;
    // 让 AI 选定的主记录代表整个簇
    const keepIdx = d.keep;
    if (find(keepIdx) === ri) parent[rj] = ri;
    else if (find(keepIdx) === rj) parent[ri] = rj;
    else parent[rj] = ri;
  }
  const groups = new Map();
  for (let i = 0; i < items.length; i += 1) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  }
  let mergedCount = 0;
  const merged = [...groups.values()].map((idx) => {
    if (idx.length === 1) return items[idx[0]];
    mergedCount += idx.length - 1;
    const keep = preferred.get(idx[0]) ?? idx[0];
    const primary = items[keep] ?? items[idx[0]];
    const others = idx.filter((i) => i !== keep).map((i) => items[i]);
    return {
      ...primary,
      alsoReportedBy: [
        ...(primary.alsoReportedBy ?? []),
        ...others.map((o) => ({ source: o.sourceName, url: o.url, title: o.title })),
      ],
      clusterSize: (primary.clusterSize ?? 1) + others.length,
    };
  });
  return { merged, mergedCount };
}