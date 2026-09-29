import { decodeEntities, stripTags, cleanText, collapseWhitespace } from "./text.mjs";

function tag(block, names) {
  for (const name of names) {
    const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i");
    const m = block.match(re);
    if (m) return unwrapCdata(m[1]);
  }
  return "";
}

function attr(block, name, attrName = "href") {
  const re = new RegExp(`<${name}\\b[^>]*\\b${attrName}=["']([^"']+)["'][^>]*>`, "i");
  const m = block.match(re);
  return m ? decodeEntities(m[1]) : "";
}

function unwrapCdata(s = "") {
  const m = String(s).match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  return m ? m[1] : s;
}

function allTags(block, name) {
  const out = [];
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "gi");
  let m;
  while ((m = re.exec(block))) out.push(collapseWhitespace(decodeEntities(unwrapCdata(m[1]))));
  return out.filter(Boolean);
}

function splitBlocks(xml, tagNames) {
  for (const name of tagNames) {
    const re = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "gi");
    const blocks = [];
    let m;
    while ((m = re.exec(xml))) blocks.push(m[1]);
    if (blocks.length) return blocks;
  }
  return [];
}

function parseDate(raw) {
  if (!raw) return null;
  const t = Date.parse(collapseWhitespace(raw));
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString();
}

/** 解析 RSS 2.0 / Atom / RDF，返回统一的条目数组。零依赖。 */
export function parseFeed(xml, { feedTitle = "", feedUrl = "" } = {}) {
  const text = String(xml ?? "");
  const channelTitle = cleanText(tag(text, ["title"])) || feedTitle;
  const blocks = splitBlocks(text, ["item", "entry"]);
  const items = [];
  for (const block of blocks) {
    const title = cleanText(tag(block, ["title"]));
    let link = attr(block, "link", "href") || collapseWhitespace(tag(block, ["link"]));
    if (!link) link = collapseWhitespace(tag(block, ["guid", "id"]));
    if (!link && /^https?:/i.test(collapseWhitespace(tag(block, ["guid"])))) link = collapseWhitespace(tag(block, ["guid"]));
    const rawSummary =
      tag(block, ["description"]) ||
      tag(block, ["summary"]) ||
      tag(block, ["content:encoded"]) ||
      tag(block, ["content"]);
    const summary = cleanText(rawSummary);
    const published =
      parseDate(tag(block, ["pubDate"])) ||
      parseDate(tag(block, ["published"])) ||
      parseDate(tag(block, ["updated"])) ||
      parseDate(tag(block, ["dc:date"])) ||
      parseDate(tag(block, ["date"]));
    const authors = [
      ...allTags(block, "dc:creator"),
      ...allTags(block, "author"),
      ...allTags(block, "name"),
    ]
      .flatMap((a) => cleanText(a).split(/[;,、]/))
      .map((a) => a.trim())
      .filter(Boolean);
    const categories = [...allTags(block, "category"), ...allTags(block, "arxiv:primary_category")];
    items.push({
      title: decodeEntities(title),
      url: decodeEntities(link).trim(),
      summary,
      published,
      authors: [...new Set(authors)].slice(0, 6),
      categories: [...new Set(categories)].slice(0, 8),
      feedTitle: channelTitle,
      feedUrl,
    });
  }
  return { feedTitle: channelTitle, items };
}

export function looksLikeFeed(text) {
  return /<\s*(rss|feed|rdf:RDF)\b/i.test(String(text).slice(0, 4000));
}

export { stripTags };