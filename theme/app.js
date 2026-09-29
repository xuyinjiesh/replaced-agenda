/* 极简交互：领域筛选 + 关键词过滤 + 快捷键。无框架、无网络请求。 */
(() => {
  const list = document.getElementById("events");
  if (!list) return;
  const rows = [...list.querySelectorAll("li.item, li.tl-item")];
  const chips = [...document.querySelectorAll(".strip .chip[data-domain]")];
  const search = document.getElementById("q");
  const countEl = document.getElementById("count");
  const state = { domain: null, q: "" };

  function apply() {
    let shown = 0;
    for (const row of rows) {
      const okDomain = !state.domain || row.dataset.domain === state.domain;
      const okText = !state.q || (row.dataset.text || "").includes(state.q);
      const ok = okDomain && okText;
      row.hidden = !ok;
      if (ok) shown += 1;
      // 搜索时自动展开：命中的关键词常常只在摘要里，折叠着就等于看不见为什么命中。
      // 只在「由搜索展开」和「原本收起」之间切换，不动用户手动展开的那些。
      const disc = row.querySelector("details.disc");
      if (!disc) continue;
      if (ok && state.q) { if (!disc.open) { disc.open = true; disc.dataset.auto = "1"; } }
      else if (!state.q && disc.dataset.auto) { disc.open = false; delete disc.dataset.auto; }
    }
    if (countEl) countEl.textContent = `${shown} / ${rows.length}`;
  }

  // 标题是去原文的链接：点它应该跳转，而不是顺手把摘要也展开
  for (const row of rows) {
    const link = row.querySelector("summary.row a.title");
    if (link) link.addEventListener("click", (ev) => ev.stopPropagation());
  }

  for (const chip of chips) {
    chip.addEventListener("click", () => {
      const key = chip.dataset.domain;
      state.domain = state.domain === key ? null : key;
      for (const c of chips) c.classList.toggle("on", c.dataset.domain === state.domain);
      apply();
    });
  }

  if (search) {
    search.addEventListener("input", () => {
      state.q = search.value.trim().toLowerCase();
      apply();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "/" && document.activeElement !== search) {
        e.preventDefault();
        search.focus();
      }
      if (e.key === "Escape" && document.activeElement === search) {
        search.value = "";
        state.q = "";
        apply();
        search.blur();
      }
    });
  }
})();