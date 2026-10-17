// Jaizz Chat — frontend. No secrets here: this file is public on GitHub Pages.

const { WORKER_URL } = window.APP_CONFIG; // set in config.js

const MAX_HISTORY = 20; // matches the Worker's cap

const chatEl = document.getElementById("chat");
const form = document.getElementById("composer");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send");
const statusEl = document.getElementById("status");

// Only user questions and final answers live here. Tool calls and results stay
// inside the Worker for a single turn; the browser never sends them back.
// (That also means a visitor can't forge a tool result.)
const history = [];

/* ---------- rendering ---------- */

function addMessage(role, text) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.textContent = text;
  chatEl.appendChild(div);
  scrollDown();
  return div;
}

function scrollDown() {
  chatEl.scrollTop = chatEl.scrollHeight;
}

// Shows which tools ran this turn: the visible evidence of the tool-use loop.
function renderToolTrace(tools) {
  const details = document.createElement("details");
  details.className = "tools";
  const summary = document.createElement("summary");
  summary.textContent = `Used ${tools.length} tool${tools.length === 1 ? "" : "s"}: ${tools.map((t) => t.name).join(", ")}`;
  details.appendChild(summary);

  for (const t of tools) {
    const item = document.createElement("div");
    item.className = "tool-call";
    const head = document.createElement("div");
    head.className = "tool-head";
    head.textContent = `${t.ok ? "✓" : "✗"} ${t.name}(${JSON.stringify(t.args)}) · ${t.ms} ms`;
    const pre = document.createElement("pre");
    pre.textContent = t.preview;
    item.append(head, pre);
    details.appendChild(item);
  }
  chatEl.appendChild(details);
}

/* ---------- chord charts ----------
 * The Worker sends charts as data ({ title, composer, key, form, style, bars }),
 * written the way a lead sheet writes them: repeats, endings, % bars and codas in place.
 * Everything here is built with DOM methods + textContent: no model text becomes HTML.
 */

const h = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const sheetQuality = ChartSheet.quality; // maj7 → Δ7, m7 → –7, m7b5 → ø7 … (charts.js)

function sheetChord(sym) {
  const span = h("span", "ch");
  const p = ChartSheet.parseChord(sym);
  if (!p) { span.append(h("span", "rt nc", sym)); return span; }
  const { root, acc, q, bass, bassAcc } = p;
  span.append(h("span", "rt", root));
  if (acc) span.append(h("span", "ac", acc === "b" ? "♭" : "♯"));
  if (q) span.append(h("span", "ql", sheetQuality(q)));
  if (bass) span.append(h("span", "bs", "/" + bass + (bassAcc === "b" ? "♭" : bassAcc === "#" ? "♯" : "")));
  return span;
}

function renderSheetChart(chart) {
  const wrap = h("div", "sheet");
  const head = h("div", "sheet-head");
  head.append(
    h("div", "sheet-style", chart.style ? `(${chart.style})` : ""),
    h("div", "sheet-title", chart.title),
    h("div", "sheet-composer", chart.composer && chart.composer !== "unknown" ? chart.composer : "")
  );
  wrap.append(head, h("div", "sheet-sub", [chart.key, chart.form].filter(Boolean).join(" · ")));

  // Same row layout as the PDF (charts.js): 4 bars a row, sections and 2nd endings start new rows.
  const rows = ChartSheet.layoutRows(chart.bars);

  const grid = h("div", "sheet-grid");
  for (const r of rows) {
    const rowEl = h("div", "sheet-row");
    if (r.some((b) => b && b.l)) rowEl.classList.add("has-label");
    for (let i = 0; i < 4; i++) {
      const b = r[i];
      if (!b) { rowEl.append(h("div", "bar empty")); continue; }
      const cell = h("div", "bar");
      if (b.o === "[") cell.classList.add("open-double");
      if (b.o === "{") cell.classList.add("open-repeat");
      if (b.e === "]") cell.classList.add("close-double");
      if (b.e === "}") cell.classList.add("close-repeat");
      if (b.e === "Z") cell.classList.add("close-final");
      const prev = r[i - 1];
      if (prev && ["]", "}", "Z"].includes(prev.e)) cell.classList.add("after-close");
      if (i === 3 || !r[i + 1]) cell.classList.add("row-end");
      if (b.inEnding) {
        cell.classList.add("ending");
        if (b.endingStart) { cell.classList.add("ending-start"); cell.append(h("span", "ending-num", `${b.n}.`)); }
      }
      if (b.l) cell.append(h("span", "lbl", b.l));
      if (b.t) {
        const t = h("span", "tsig");
        const [top, bottom] = b.t.split("/");
        t.append(h("span", null, top), h("span", null, bottom));
        cell.append(t);
      }
      const marks = [b.s && "𝄋", b.q && "𝄌", b.f && "𝄐"].filter(Boolean).join(" ");
      if (marks) cell.append(h("span", "sym", marks));
      const body = h("div", "chords");
      if (b.r) {
        const rp = h("span", "rpt", "%");
        if (b.r === "%2") rp.append(h("sup", null, "2"));
        body.append(rp);
      } else {
        for (const c of b.c || []) body.append(sheetChord(c));
      }
      cell.append(body);
      if (b.m) cell.append(h("span", "cmt", b.m));
      rowEl.append(cell);
    }
    grid.append(rowEl);
  }
  wrap.append(grid);
  return withChartMenu(chart, wrap);
}

/* ---------- chart menu, setlist and PDFs ----------
 * Nothing happens when you tap a chart itself: every action is behind its ⋯ menu,
 * so scrolling on a phone can't set one off. The setlist lives in this browser only.
 */

const toastEl = document.getElementById("toast");
let toastTimer;
function toast(text) {
  if (!toastEl) return;
  toastEl.textContent = text;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2600);
}

const SETLIST_KEY = "jaizz.setlist.v1";
const chartId = (c) => `${c.title}|${c.key || ""}`;

function loadSetlist() {
  try {
    const s = JSON.parse(localStorage.getItem(SETLIST_KEY) || "null");
    if (s && Array.isArray(s.charts)) return { name: String(s.name || ""), charts: s.charts.filter((c) => c && c.title && Array.isArray(c.bars)) };
  } catch { /* private window or bad data: start empty */ }
  return { name: "", charts: [] };
}
const setlist = loadSetlist();
function saveSetlist() {
  try { localStorage.setItem(SETLIST_KEY, JSON.stringify(setlist)); } catch { /* storage full or blocked: keep it in memory */ }
  updateSetlistButton();
}
const inSetlist = (chart) => setlist.charts.some((c) => chartId(c) === chartId(chart));

const setlistBtn = document.getElementById("setlist-btn");
function updateSetlistButton() {
  if (!setlistBtn) return;
  setlistBtn.hidden = setlist.charts.length === 0;
  setlistBtn.querySelector(".count").textContent = setlist.charts.length;
}

let openMenu = null; // { close } of the chart menu that's open, if any
function closeOpenMenu() { if (openMenu) openMenu.close(); }
document.addEventListener("pointerdown", (e) => { if (openMenu && !openMenu.contains(e.target)) closeOpenMenu(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && openMenu) { const m = openMenu; m.close(); m.button.focus(); } });

async function makePdf(job, busyEl, busyText) {
  const label = busyEl.textContent;
  busyEl.disabled = true;
  busyEl.textContent = busyText;
  try {
    await job();
  } catch (err) {
    console.error(err);
    toast("Couldn't make the PDF. Check your connection and try again.");
  } finally {
    busyEl.disabled = false;
    busyEl.textContent = label;
  }
}

function withChartMenu(chart, sheetEl) {
  const outer = h("div", "sheet-wrap");
  const button = h("button", "sheet-menu-btn", "⋯");
  button.type = "button";
  button.setAttribute("aria-label", `Options for ${chart.title}`);
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");

  const menu = h("div", "sheet-menu");
  menu.setAttribute("role", "menu");
  menu.hidden = true;
  const pdfItem = h("button", null, "Download PDF");
  const setItem = h("button");
  for (const b of [pdfItem, setItem]) { b.type = "button"; b.setAttribute("role", "menuitem"); }
  menu.append(pdfItem, setItem);

  const state = {
    button,
    contains: (node) => outer.contains(node),
    close() {
      menu.hidden = true;
      button.setAttribute("aria-expanded", "false");
      if (openMenu === state) openMenu = null;
    },
  };
  button.addEventListener("click", () => {
    if (openMenu === state) { state.close(); return; }
    closeOpenMenu();
    setItem.textContent = inSetlist(chart) ? "Remove from setlist" : "Add to setlist";
    menu.hidden = false;
    button.setAttribute("aria-expanded", "true");
    openMenu = state;
    pdfItem.focus();
  });
  pdfItem.addEventListener("click", async () => {
    await makePdf(() => ChartSheet.downloadChart(chart), pdfItem, "Making PDF…");
    state.close();
  });
  setItem.addEventListener("click", () => {
    if (inSetlist(chart)) {
      setlist.charts = setlist.charts.filter((c) => chartId(c) !== chartId(chart));
      toast(`Removed ${chart.title} from the setlist`);
    } else {
      setlist.charts.push(chart);
      toast(`Added ${chart.title} · ${setlist.charts.length} in the setlist`);
    }
    saveSetlist();
    renderSetlist();
    state.close();
  });

  outer.append(button, menu, sheetEl);
  return outer;
}

/* the setlist panel */

const setlistDialog = document.getElementById("setlist");
const setlistItems = document.getElementById("setlist-items");
const setlistEmpty = document.getElementById("setlist-empty");
const setlistName = document.getElementById("setlist-name");
const setlistDownload = document.getElementById("setlist-download");
const setlistClear = document.getElementById("setlist-clear");

function moveInSetlist(i, delta) {
  const j = i + delta;
  if (j < 0 || j >= setlist.charts.length) return;
  [setlist.charts[i], setlist.charts[j]] = [setlist.charts[j], setlist.charts[i]];
  saveSetlist();
  renderSetlist();
  setlistItems.children[j]?.querySelector(delta < 0 ? ".sl-up" : ".sl-down")?.focus();
}

function renderSetlist() {
  if (!setlistItems) return;
  setlistItems.replaceChildren();
  setlist.charts.forEach((c, i) => {
    const li = h("li");
    const title = h("span", "sl-title", c.title);
    title.append(h("span", "sl-key", c.key || ""));
    const tools = h("span", "sl-tools");
    const mk = (cls, text, label, fn, disabled) => {
      const b = h("button", cls, text);
      b.type = "button";
      b.setAttribute("aria-label", label);
      b.disabled = disabled;
      b.addEventListener("click", fn);
      return b;
    };
    tools.append(
      mk("sl-up", "↑", `Move ${c.title} up`, () => moveInSetlist(i, -1), i === 0),
      mk("sl-down", "↓", `Move ${c.title} down`, () => moveInSetlist(i, 1), i === setlist.charts.length - 1),
      mk("sl-remove", "×", `Remove ${c.title}`, () => { setlist.charts.splice(i, 1); saveSetlist(); renderSetlist(); }, false),
    );
    li.append(title, tools);
    setlistItems.append(li);
  });
  const empty = setlist.charts.length === 0;
  setlistEmpty.hidden = !empty;
  setlistDownload.disabled = empty;
  setlistClear.disabled = empty;
}

if (setlistDialog) {
  setlistBtn.addEventListener("click", () => {
    setlistName.value = setlist.name;
    renderSetlist();
    setlistDialog.showModal();
  });
  setlistDialog.querySelector(".sl-close").addEventListener("click", () => setlistDialog.close());
  // A tap on the dim backdrop (outside the panel) closes it too.
  setlistDialog.addEventListener("click", (e) => { if (e.target === setlistDialog) setlistDialog.close(); });
  setlistName.addEventListener("input", () => { setlist.name = setlistName.value.slice(0, 60); saveSetlist(); });
  setlistDownload.addEventListener("click", () =>
    makePdf(() => ChartSheet.downloadSetlist(setlist.name.trim() || "Setlist", setlist.charts), setlistDownload, "Making PDF…"));
  // Two taps to clear, never a browser confirm() box.
  let clearArmed = null;
  setlistClear.addEventListener("click", () => {
    if (!clearArmed) {
      setlistClear.textContent = "Tap again to clear";
      clearArmed = setTimeout(() => { clearArmed = null; setlistClear.textContent = "Clear"; }, 3000);
      return;
    }
    clearTimeout(clearArmed);
    clearArmed = null;
    setlistClear.textContent = "Clear";
    setlist.charts = [];
    saveSetlist();
    renderSetlist();
  });
  setlistDialog.addEventListener("close", () => {
    if (clearArmed) { clearTimeout(clearArmed); clearArmed = null; setlistClear.textContent = "Clear"; }
  });
}
updateSetlistButton();

/* ---------- plain-text chord charts (fallback for ```chart blocks) ---------- */

// Pretty accidentals for display only: Bb7b9 → B♭7♭9, F#m7 → F♯m7.
function prettyChord(c) {
  return c
    .replace(/^([A-G])b/, "$1♭")
    .replace(/^([A-G])#/, "$1♯")
    .replace(/\/([A-G])b/, "/$1♭")
    .replace(/\/([A-G])#/, "/$1♯")
    .replace(/b(5|9|13)/g, "♭$1")
    .replace(/#(5|9|11)/g, "♯$1");
}

const isChartRow = (line) => (line.match(/\|/g) || []).length >= 3 && !/^\s*\|?\s*:?-{2,}/.test(line);

/**
 * Render chart text ("A  | Cm7 | F7 | Bbmaj7 | Ebmaj7 |") as a bar grid.
 * Built with DOM methods + textContent, so model text is never parsed as HTML.
 */
function renderChart(text) {
  const wrap = document.createElement("div");
  wrap.className = "chart";
  let titled = false;
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    if (!line.includes("|")) {
      const t = document.createElement("div");
      t.className = titled ? "chart-note" : "chart-title";
      t.textContent = line.trim();
      wrap.appendChild(t);
      titled = true;
      continue;
    }
    const parts = line.split("|");
    const label = parts[0].trim();
    const bars = parts.slice(1).map((b) => b.trim());
    if (bars.length && bars[bars.length - 1] === "") bars.pop();

    const row = document.createElement("div");
    row.className = label ? "chart-row section-start" : "chart-row";
    const lab = document.createElement("span");
    lab.className = "chart-label";
    lab.textContent = label;
    row.appendChild(lab);
    for (const bar of bars) {
      const cell = document.createElement("span");
      cell.className = "chart-bar";
      for (const chord of bar.split(/\s+/).filter(Boolean)) {
        const c = document.createElement("span");
        c.className = "chord";
        c.textContent = prettyChord(chord);
        cell.appendChild(c);
      }
      row.appendChild(cell);
    }
    wrap.appendChild(row);
  }
  return wrap.outerHTML;
}

/**
 * Minimal markdown → HTML. Safe because EVERYTHING is HTML-escaped first; only the
 * tags this function itself adds can appear. Model output is untrusted input.
 */
function renderMarkdown(src) {
  const esc = (s) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const inline = (s) =>
    esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, "$1<em>$2</em>")
      .replace(/(^|[^_\w])_([^_\s][^_]*?)_(?!\w)/g, "$1<em>$2</em>")
      .replace(
        /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
      );

  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    // Fenced code block. ```chart (or any block that looks like a chart) → chord grid.
    const fence = line.match(/^\s*```\s*([\w-]*)/);
    if (fence) {
      const lang = fence[1].toLowerCase();
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) { body.push(lines[i]); i++; }
      i++; // skip closing fence
      const text = body.join("\n");
      if (lang === "chart" || body.filter(isChartRow).length >= 2) out.push(renderChart(text));
      else out.push(`<pre class="code-block"><code>${esc(text)}</code></pre>`);
      continue;
    }

    // Chart rows the model forgot to fence: 2+ consecutive "| x | y | z |" lines.
    if (isChartRow(line) && i + 1 < lines.length && isChartRow(lines[i + 1])) {
      const body = [];
      while (i < lines.length && isChartRow(lines[i])) { body.push(lines[i]); i++; }
      out.push(renderChart(body.join("\n")));
      continue;
    }

    // Headings → bold paragraph (keeps chat bubbles compact)
    const h = line.match(/^#{1,6}\s+(.*)$/);
    if (h) { out.push(`<p><strong>${inline(h[1])}</strong></p>`); i++; continue; }

    // Bulleted list
    if (/^\s*[-*•]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i])) {
        items.push(`<li>${inline(lines[i].replace(/^\s*[-*•]\s+/, ""))}</li>`);
        i++;
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    // Numbered list
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(`<li>${inline(lines[i].replace(/^\s*\d+[.)]\s+/, ""))}</li>`);
        i++;
      }
      out.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    // Table (models sometimes ignore "no tables")
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const cells = (row) => row.trim().replace(/^\||\|$/g, "").split("|").map((c) => inline(c.trim()));
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(cells(lines[i])); i++; }
      out.push(
        `<table><thead><tr>${head.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>` +
          rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("") +
          `</tbody></table>`
      );
      continue;
    }

    // Paragraph: consecutive plain lines
    const para = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,6}\s|\s*[-*•]\s+|\s*\d+[.)]\s+|\s*\||\s*```)/.test(lines[i])
    ) {
      para.push(inline(lines[i]));
      i++;
    }
    out.push(`<p>${para.join("<br>")}</p>`);
  }
  return out.join("");
}

/* ---------- sending ---------- */

function setBusy(busy) {
  document.body.classList.toggle("busy", busy); // the marquee bulbs chase while we wait
  input.disabled = busy;
  sendBtn.disabled = busy;
  sendBtn.textContent = busy ? "…" : "Send";
}

// The answer landed: the marquee bulbs hit two stabs, then go back to the backbeat.
function playStabs() {
  document.body.classList.remove("hit");
  void document.body.offsetWidth; // restart the stabs if they're still playing
  document.body.classList.add("hit");
  setTimeout(() => document.body.classList.remove("hit"), 800);
}

async function send(text) {
  if (examplesEl) examplesEl.hidden = true;
  history.push({ role: "user", content: text });
  addMessage("user", text);
  const pending = addMessage("assistant pending", "");
  // Fixed markup only (no user text), so innerHTML is safe here.
  pending.innerHTML = '<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="thinking-label">Thinking</span>';
  pending.setAttribute("aria-label", "Thinking");
  const labelEl = pending.querySelector(".thinking-label");
  const slowTimer = setTimeout(() => { labelEl.textContent = "Looking things up, this can take a few seconds"; }, 4000);
  setBusy(true);

  try {
    const res = await fetch(`${WORKER_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: history.slice(-MAX_HISTORY) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);

    pending.className = "msg assistant md";
    pending.innerHTML = renderMarkdown(data.reply); // safe: renderMarkdown escapes first
    for (const chart of data.charts || []) chatEl.appendChild(renderSheetChart(chart));
    if (data.tools?.length) renderToolTrace(data.tools);
    history.push({ role: "assistant", content: data.reply });
    playStabs();

    const toolNote = data.tools?.length ? `tools: ${data.tools.map((t) => t.name).join(", ")}` : "no tools (answered from model knowledge)";
    statusEl.textContent = `Answered by ${data.model} via ${data.provider} · ${toolNote}`;
    scrollDown();
  } catch (err) {
    pending.className = "msg error";
    pending.textContent = err.message;
    history.pop(); // drop the failed user turn so a retry doesn't duplicate it
  } finally {
    clearTimeout(slowTimer);
    pending.removeAttribute("aria-label");
    setBusy(false);
    input.focus();
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  autoGrow();
  send(text);
});

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});

function autoGrow() {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  input.style.overflowY = input.scrollHeight > 160 ? "auto" : "hidden";
}
input.addEventListener("input", autoGrow);

// Phones: the full placeholder doesn't fit on one line, so use a shorter one.
const LONG_PLACEHOLDER = input.placeholder;
const narrow = window.matchMedia("(max-width: 600px)");
const tiny = window.matchMedia("(max-width: 420px)");
function setPlaceholder() {
  input.placeholder = tiny.matches ? "Ask me about jazz…" : narrow.matches ? "Ask about a player or a tune…" : LONG_PLACEHOLDER;
}
narrow.addEventListener("change", setPlaceholder);
tiny.addEventListener("change", setPlaceholder);
setPlaceholder();

// Example prompts: a click fills the input (the user still presses Send).
const examplesEl = document.getElementById("examples");
examplesEl?.addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  input.value = chip.textContent;
  autoGrow();
  input.focus();
});
