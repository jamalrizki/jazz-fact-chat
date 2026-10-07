// Jazz Fact Chat — frontend. No secrets here: this file is public on GitHub Pages.

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

/* ---------- chord charts ---------- */

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
  input.disabled = busy;
  sendBtn.disabled = busy;
  sendBtn.textContent = busy ? "…" : "Send";
}

async function send(text) {
  history.push({ role: "user", content: text });
  addMessage("user", text);
  const pending = addMessage("assistant pending", "Thinking… (tool calls can take a few seconds)");
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
    if (data.tools?.length) renderToolTrace(data.tools);
    history.push({ role: "assistant", content: data.reply });

    const toolNote = data.tools?.length ? `tools: ${data.tools.map((t) => t.name).join(", ")}` : "no tools (answered from model knowledge)";
    statusEl.textContent = `Answered by ${data.model} via ${data.provider} · ${toolNote}`;
    scrollDown();
  } catch (err) {
    pending.className = "msg error";
    pending.textContent = err.message;
    history.pop(); // drop the failed user turn so a retry doesn't duplicate it
  } finally {
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
}
input.addEventListener("input", autoGrow);
