// Jaizz Chat — "Show chart" and "Add to setlist" buttons under a find_tunes list.
// When the chat lists tunes ("a few bossas", "Miles Davis tunes"), the Worker also sends the
// titles to the page. A tap asks the chord_chart tool for that one tune over the public MCP
// endpoint (one tools/call, no model involved), so the chart is the same one the chat shows.
// Needs setlist-print.js loaded first (it checks the reply with SetlistPrint.chartFromReply).
// No secrets here: this file is public on GitHub Pages.

(function (root) {
  const MAX_TUNES = 10;
  const MAX_LISTS = 4;

  // The Worker's lists, checked before anything reaches the page: plain strings only, capped.
  function cleanLists(lists) {
    if (!Array.isArray(lists)) return [];
    const text = (v) => (typeof v === "string" ? v.slice(0, 60) : "");
    return lists
      .slice(0, MAX_LISTS)
      .map((l) =>
        (l && Array.isArray(l.tunes) ? l.tunes : [])
          .filter((t) => t && typeof t.title === "string" && t.title.trim())
          .slice(0, MAX_TUNES)
          .map((t) => ({ title: t.title.slice(0, 120), key: text(t.key), form: text(t.form), style: text(t.style) }))
      )
      .filter((tunes) => tunes.length > 0);
  }

  // "C minor · 16 bars · Bossa Nova"
  function meta(tune) {
    return [tune.key, tune.form, tune.style].filter(Boolean).join(" · ");
  }

  function chartRequest(title) {
    return { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "chord_chart", arguments: { tune: title } } };
  }

  // One tune's chart, in the same shape the chat hands the page, or null if the reply
  // isn't a clean match for that title (the reply is checked, not trusted).
  async function fetchChart(title, { url, fetchFn }) {
    const res = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify(chartRequest(title)),
    });
    if (!res.ok) throw new Error(`MCP HTTP ${res.status}`);
    const reply = await res.json();
    return root.SetlistPrint.chartFromReply(Array.isArray(reply) ? reply[0] : reply, { title });
  }

  root.TunePicks = { cleanLists, meta, chartRequest, fetchChart };
})(typeof window !== "undefined" ? window : globalThis);
