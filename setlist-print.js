// Jaizz Chat — setlist "Print for" switch (concert, Bb, Eb or F).
// The page does no transposing itself. It asks the chord_chart tool again, over the public
// MCP endpoint (one JSON-RPC batch, no model involved), for each chart in its concert key
// plus the chosen instrument, so the interval math stays in one place: the Worker.
// No secrets here: this file is public on GitHub Pages.

(function (root) {
  const INSTRUMENTS = ["concert", "Bb", "Eb", "F"];
  const SAVED = "saved"; // print every chart as it was saved (the default)
  const FOR_SUFFIX = /, for (Bb|Eb|F) instruments$/;
  const KEY_ROOT = /^[A-G][b#]?$/;
  const BATCH = 20; // the Worker's /mcp accepts at most 20 messages per batch

  // Which instrument a saved chart is written for, from its header ("E minor, for Eb instruments").
  function writtenFor(chart) {
    const m = typeof chart.key === "string" && chart.key.match(FOR_SUFFIX);
    return m ? m[1] : "concert";
  }

  // The chart's concert key label ("G minor"), or null if it can't be known. Charts saved before
  // concert_key existed are fine when they're concert; an older Bb/Eb/F chart has no concert key.
  function concertKeyOf(chart) {
    if (typeof chart.concert_key === "string" && chart.concert_key) return chart.concert_key;
    if (typeof chart.key === "string" && chart.key && !FOR_SUFFIX.test(chart.key)) return chart.key;
    return null;
  }

  // One tools/call per chart that needs a different written key. `id` is the chart's index.
  function planRequests(charts, instrument) {
    const requests = [];
    const unknown = [];
    if (instrument === SAVED || !INSTRUMENTS.includes(instrument)) return { requests, unknown };
    charts.forEach((c, i) => {
      if (writtenFor(c) === instrument) return; // already right
      const rootName = (concertKeyOf(c) || "").split(" ")[0];
      if (!KEY_ROOT.test(rootName)) { unknown.push(i); return; }
      requests.push({
        jsonrpc: "2.0",
        id: i,
        method: "tools/call",
        params: { name: "chord_chart", arguments: { tune: c.title, key: rootName, instrument } },
      });
    });
    return { requests, unknown };
  }

  // A tools/call reply → the same chart object the chat hands the page, or null if it isn't
  // a clean match for the chart we asked about (the reply is checked, not trusted).
  function chartFromReply(reply, asked) {
    const r = reply && reply.result;
    const sc = r && !r.isError && r.structuredContent;
    if (!sc || sc.found !== true || sc.title !== asked.title) return null;
    if (typeof sc.key !== "string" || !sc.layout || !Array.isArray(sc.layout.bars)) return null;
    if (sc.instrument !== undefined && !INSTRUMENTS.includes(sc.instrument)) return null;
    return {
      title: sc.title,
      composer: sc.composer,
      key: sc.instrument ? `${sc.key}, for ${sc.instrument} instruments` : sc.key,
      concert_key: sc.concert_key || sc.key,
      form: sc.form,
      style: sc.layout.style ?? null,
      bars: sc.layout.bars,
    };
  }

  // Returns { charts, kept }: the charts to print, and the titles left as saved.
  async function chartsFor(charts, instrument, { url, fetchFn }) {
    const { requests, unknown } = planRequests(charts, instrument);
    const out = charts.slice();
    const kept = new Set(unknown);
    for (let i = 0; i < requests.length; i += BATCH) {
      const chunk = requests.slice(i, i + BATCH);
      const res = await fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify(chunk),
      });
      if (!res.ok) throw new Error(`MCP HTTP ${res.status}`);
      const replies = await res.json();
      const byId = new Map((Array.isArray(replies) ? replies : [replies]).map((r) => [r && r.id, r]));
      for (const req of chunk) {
        const chart = chartFromReply(byId.get(req.id), charts[req.id]);
        if (chart) out[req.id] = chart;
        else kept.add(req.id);
      }
    }
    return { charts: out, kept: [...kept].sort((a, b) => a - b).map((i) => charts[i].title) };
  }

  /* ---------- "Download in all 12 keys" ----------
   * Same idea as "Print for": the page names 12 concert keys and asks chord_chart for each one
   * (one batch), so the transposing is still done by the tool. Round the cycle of fourths from
   * the chart's own key. Key names are a fixed list of ordinary key signatures, one per pitch
   * class, passed to chord_chart as-is; the chart's own key keeps the name it already has.
   */
  const CYCLE_MAJOR = ["C", "F", "Bb", "Eb", "Ab", "Db", "Gb", "B", "E", "A", "D", "G"];
  const CYCLE_MINOR = ["C", "F", "Bb", "Eb", "G#", "C#", "F#", "B", "E", "A", "D", "G"];
  const LETTER_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const pcOf = (name) => (LETTER_PC[name[0]] + (name[1] === "#" ? 1 : name[1] === "b" ? -1 : 0) + 12) % 12;

  // The 12 tools/call requests for one chart, or [] if its concert key can't be known.
  // `id` is the position in the cycle (0 = the chart's own key). The instrument it's written for is kept.
  function planAllKeys(chart) {
    const concert = chart && concertKeyOf(chart);
    if (!concert || typeof chart.title !== "string" || !chart.title) return [];
    const m = concert.match(/^([A-G][b#]?)(?: (major|minor))?$/);
    if (!m) return [];
    const cycle = m[2] === "minor" ? CYCLE_MINOR : CYCLE_MAJOR;
    const start = cycle.findIndex((k) => pcOf(k) === pcOf(m[1]));
    const keys = cycle.map((_, i) => (i === 0 ? m[1] : cycle[(start + i) % 12]));
    const instrument = writtenFor(chart);
    return keys.map((key, id) => ({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "chord_chart", arguments: { tune: chart.title, key, instrument } },
    }));
  }

  // Returns { charts, missing }: the charts that came back, in cycle order, and the concert
  // key roots that didn't (each left out, never a half-made page). Throws if /mcp can't be reached.
  async function allKeys(chart, { url, fetchFn }) {
    const requests = planAllKeys(chart);
    if (!requests.length) return { charts: [], missing: [] };
    const res = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify(requests),
    });
    if (!res.ok) throw new Error(`MCP HTTP ${res.status}`);
    const replies = await res.json();
    const byId = new Map((Array.isArray(replies) ? replies : [replies]).map((r) => [r && r.id, r]));
    const charts = [];
    const missing = [];
    for (const req of requests) {
      const c = chartFromReply(byId.get(req.id), chart);
      if (c) charts.push(c);
      else missing.push(req.params.arguments.key);
    }
    return { charts, missing };
  }

  // Shown on the cover page and in the file name.
  function label(instrument) {
    return instrument === "concert" ? "concert" : INSTRUMENTS.includes(instrument) ? `for ${instrument}` : "";
  }

  root.SetlistPrint = { INSTRUMENTS, SAVED, writtenFor, concertKeyOf, planRequests, chartFromReply, chartsFor, label, planAllKeys, allKeys };
})(typeof window !== "undefined" ? window : globalThis);
