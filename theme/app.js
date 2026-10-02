(() => {
  const storyList = document.getElementById("story-list");
  if (!storyList) return;

  const stories = [...document.querySelectorAll("article[data-v2-record]")];
  const search = document.getElementById("search");
  const resultCount = document.getElementById("result-count");
  const appliedFilters = document.getElementById("applied-filters");
  const emptyResults = document.getElementById("empty-results");
  const sortMenu = document.getElementById("sort-menu");
  const sortTrigger = document.getElementById("sort-trigger");
  const filterMenu = document.getElementById("filter-popover");
  const filterTrigger = document.getElementById("filter-trigger");
  const minFilter = document.getElementById("min-filter");
  const minOutput = document.getElementById("min-output");
  const sortNames = { value: "推进强度", date: "最新发布", confidence: "证据可信度" };
  const sortOptions = sortMenu ? [...sortMenu.querySelectorAll('[data-action="sort"]')] : [];
  const savedKey = "replaced-agenda:saved";
  const state = { domain: null, query: "", sort: "value", savedOnly: false, direct: false, verified: false, min: 0 };
  let saved = new Set();

  try {
    const value = JSON.parse(localStorage.getItem(savedKey) || "[]");
    if (Array.isArray(value)) saved = new Set(value.map(String));
  } catch {}

  const filterGroups = () => {
    if (storyList.classList.contains("story-list")) return [storyList];
    return [...storyList.querySelectorAll(".story-list")];
  };

  function setExpanded(row, open, automatic = false) {
    const panel = row.querySelector(".v2-details");
    const toggle = row.querySelector(".v2-read-toggle");
    if (!panel || !toggle) return;
    const before = toggle.getBoundingClientRect();
    panel.hidden = !open;
    row.classList.toggle("expanded", open);
    row.querySelectorAll('[data-action="expand"]').forEach((button) => button.setAttribute("aria-expanded", String(open)));
    const label = toggle.querySelector("[data-toggle-label]");
    if (label) label.textContent = open ? "收起内容" : "阅读摘要";
    if (automatic) row.dataset.autoExpanded = "1";
    else delete row.dataset.autoExpanded;
    requestAnimationFrame(() => {
      const shift = toggle.getBoundingClientRect().top - before.top;
      if (Math.abs(shift) > 0.5) window.scrollBy({ top: shift, behavior: "instant" });
    });
  }

  function updateSaved() {
    try { localStorage.setItem(savedKey, JSON.stringify([...saved])); } catch {}
    document.querySelectorAll("[data-saved-count]").forEach((el) => { el.textContent = String(saved.size); });
    for (const row of stories) {
      const button = row.querySelector('[data-action="save"]');
      if (!button) continue;
      const active = saved.has(row.dataset.id);
      button.classList.toggle("is-saved", active);
      button.setAttribute("aria-pressed", String(active));
      button.setAttribute("aria-label", active ? "从稍后读移除" : "加入稍后读");
      button.title = active ? "从稍后读移除" : "加入稍后读";
    }
  }

  function updateSortMenu() {
    const label = document.getElementById("sort-label");
    if (label) label.textContent = sortNames[state.sort];
    for (const option of sortOptions) {
      const active = option.dataset.sort === state.sort;
      option.setAttribute("aria-checked", String(active));
      option.tabIndex = active ? 0 : -1;
    }
  }

  function applySort() {
    for (const group of filterGroups()) {
      const order = [...group.querySelectorAll(":scope > article[data-v2-record]")];
      order.sort((a, b) => {
        if (state.sort === "date") return b.dataset.date.localeCompare(a.dataset.date) || a.dataset.id.localeCompare(b.dataset.id);
        const aValue = Number(a.dataset[state.sort] || 0);
        const bValue = Number(b.dataset[state.sort] || 0);
        return bValue - aValue || a.dataset.id.localeCompare(b.dataset.id);
      });
      for (const [index, row] of order.entries()) {
        group.append(row);
        row.classList.toggle("is-featured", index === 0);
        const number = row.querySelector(".story-number");
        if (number) number.textContent = String(index + 1).padStart(2, "0");
      }
    }
  }

  function apply() {
    let shown = 0;
    for (const row of stories) {
      const matches = (!state.domain || row.dataset.domain === state.domain)
        && (!state.query || (row.dataset.text || "").includes(state.query))
        && (!state.savedOnly || saved.has(row.dataset.id))
        && (!state.direct || row.dataset.relation === "direct")
        && (!state.verified || row.dataset.verified === "true")
        && Number(row.dataset.value || 0) >= state.min;
      row.hidden = !matches;
      if (matches) shown += 1;
      if (matches && state.query) {
        const panel = row.querySelector(".v2-details");
        if (panel?.hidden && !row.dataset.autoExpanded) setExpanded(row, true, true);
      } else if (!state.query && row.dataset.autoExpanded) {
        setExpanded(row, false);
      }
    }
    for (const section of storyList.querySelectorAll(".tl-day")) {
      section.hidden = !section.querySelector('article[data-v2-record]:not([hidden])');
    }
    applySort();
    if (resultCount) resultCount.textContent = `${shown} / ${stories.length} 条记录`;
    if (emptyResults) emptyResults.hidden = shown > 0;
    const labels = [];
    if (state.domain) labels.push(document.querySelector(`[data-domain-filter="${CSS.escape(state.domain)}"]`)?.textContent.trim() || state.domain);
    if (state.savedOnly) labels.push("我的稍后读");
    if (state.direct) labels.push("直接任务进展");
    if (state.verified) labels.push("引文已核对");
    if (state.min > 0) labels.push(`推进强度 ≥ ${state.min.toFixed(2)}`);
    if (state.query) labels.push(`搜索：${state.query}`);
    if (appliedFilters) appliedFilters.textContent = labels.join(" · ");
    document.querySelectorAll("[data-domain-filter]").forEach((button) => {
      const active = button.dataset.domainFilter === state.domain;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    if (filterTrigger) filterTrigger.classList.toggle("has-filter", state.direct || state.verified || state.min > 0);
  }

  function positionPopover(popover, trigger, width, mobileSheet = false) {
    if (!popover || !trigger || !popover.matches(":popover-open")) return;
    if (mobileSheet && window.matchMedia("(max-width: 620px)").matches) return;
    const rect = trigger.getBoundingClientRect();
    const actualWidth = popover.offsetWidth || width;
    const actualHeight = popover.offsetHeight || 220;
    const left = Math.max(12, Math.min(rect.right - actualWidth, innerWidth - actualWidth - 12));
    const below = rect.bottom + 8;
    const top = below + actualHeight <= innerHeight - 12 ? below : Math.max(12, rect.top - actualHeight - 8);
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
  }

  function setMenuFocus(index) {
    sortOptions.forEach((option, i) => { option.tabIndex = i === index ? 0 : -1; });
    sortOptions[index]?.focus({ preventScroll: true });
  }

  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (target.closest("a")) return;
    const action = target.closest("[data-action]");
    if (action) {
      const kind = action.dataset.action;
      if (kind === "expand") {
        const row = action.closest("[data-v2-record]");
        if (row && (!target.closest("button") || action.matches("button"))) {
          const panel = row.querySelector(".v2-details");
          setExpanded(row, Boolean(panel?.hidden));
        }
        return;
      }
      if (kind === "save") {
        event.preventDefault();
        event.stopPropagation();
        const id = action.dataset.id;
        if (saved.has(id)) saved.delete(id); else saved.add(id);
        updateSaved();
        apply();
        return;
      }
      if (kind === "saved-list") {
        state.savedOnly = !state.savedOnly;
        action.setAttribute("aria-pressed", String(state.savedOnly));
        action.classList.toggle("active", state.savedOnly);
        apply();
        return;
      }
      if (kind === "sort") {
        state.sort = action.dataset.sort;
        updateSortMenu();
        apply();
        sortMenu?.hidePopover();
        sortTrigger?.focus({ preventScroll: true });
        return;
      }
      if (kind === "filter") {
        setTimeout(() => positionPopover(filterMenu, filterTrigger, 300, true), 0);
        return;
      }
      if (kind === "close-filter") {
        filterMenu?.hidePopover();
        filterTrigger?.focus({ preventScroll: true });
        return;
      }
      if (kind === "clear-filters") {
        state.domain = null;
        state.direct = false;
        state.verified = false;
        state.min = 0;
        document.querySelectorAll('[data-filter="direct"], [data-filter="verified"]').forEach((input) => { input.checked = false; });
        if (minFilter) minFilter.value = "0";
        if (minOutput) minOutput.textContent = "0.00";
        if (search) search.value = "";
        state.query = "";
        apply();
        return;
      }
    }
    const domainButton = target.closest("[data-domain-filter]");
    if (domainButton) {
      state.domain = state.domain === domainButton.dataset.domainFilter ? null : domainButton.dataset.domainFilter;
      apply();
    }
  });

  for (const header of document.querySelectorAll('.v2-entry-header[data-action="expand"]')) {
    header.addEventListener("keydown", (event) => {
      if ((event.key === "Enter" || event.key === " ") && !event.target.closest("a")) {
        event.preventDefault();
        const row = header.closest("[data-v2-record]");
        const panel = row?.querySelector(".v2-details");
        if (row) setExpanded(row, Boolean(panel?.hidden));
      }
    });
  }

  if (search) {
    search.addEventListener("input", () => {
      state.query = search.value.trim().toLowerCase();
      apply();
    });
  }
  document.querySelectorAll('[data-filter="direct"]').forEach((input) => input.addEventListener("change", () => { state.direct = input.checked; apply(); }));
  document.querySelectorAll('[data-filter="verified"]').forEach((input) => input.addEventListener("change", () => { state.verified = input.checked; apply(); }));
  if (minFilter) minFilter.addEventListener("input", () => {
    state.min = Number(minFilter.value);
    if (minOutput) minOutput.textContent = state.min.toFixed(2);
    apply();
  });

  sortMenu?.addEventListener("beforetoggle", (event) => {
    sortTrigger?.setAttribute("aria-expanded", String(event.newState === "open"));
    if (event.newState === "open") setTimeout(() => positionPopover(sortMenu, sortTrigger, 250), 0);
  });
  sortMenu?.addEventListener("keydown", (event) => {
    const index = sortOptions.indexOf(document.activeElement);
    let next = null;
    if (event.key === "ArrowDown") next = (index + 1) % sortOptions.length;
    if (event.key === "ArrowUp") next = (index + sortOptions.length - 1) % sortOptions.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = sortOptions.length - 1;
    if (next !== null) { event.preventDefault(); setMenuFocus(next); }
    if (event.key === "Escape") {
      event.preventDefault();
      sortMenu.hidePopover();
      sortTrigger?.focus({ preventScroll: true });
    }
  });
  sortTrigger?.addEventListener("keydown", (event) => {
    if (!sortMenu || !["ArrowDown", "ArrowUp"].includes(event.key)) return;
    event.preventDefault();
    if (!sortMenu.matches(":popover-open")) sortMenu.showPopover();
    setMenuFocus(sortOptions.findIndex((option) => option.dataset.sort === state.sort));
  });
  filterMenu?.addEventListener("beforetoggle", () => setTimeout(() => positionPopover(filterMenu, filterTrigger, 300, true), 0));
  window.addEventListener("resize", () => {
    positionPopover(sortMenu, sortTrigger, 250);
    positionPopover(filterMenu, filterTrigger, 300, true);
  });
  window.addEventListener("scroll", () => {
    positionPopover(sortMenu, sortTrigger, 250);
    positionPopover(filterMenu, filterTrigger, 300, true);
  }, { passive: true });
  document.addEventListener("keydown", (event) => {
    if (event.key === "/" && search && document.activeElement !== search) {
      event.preventDefault();
      search.focus();
    }
    if (event.key === "Escape" && search && document.activeElement === search) {
      search.value = "";
      state.query = "";
      apply();
      search.blur();
    }
  });

  updateSaved();
  updateSortMenu();
  apply();
})();
