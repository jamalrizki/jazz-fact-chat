// Docs page: the tool list is fetched live from the MCP server (tools/list),
// so this page can never drift out of sync with the code.

const { WORKER_URL } = window.APP_CONFIG;
const MCP_URL = `${WORKER_URL}/mcp`;

document.querySelectorAll(".mcp-url").forEach((el) => (el.textContent = MCP_URL));
const curl = document.getElementById("curl-example");
curl.textContent = curl.textContent.replace("…/mcp", MCP_URL);

const statusEl = document.getElementById("live-status");
const listEl = document.getElementById("tool-list");

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text; // textContent: server data is never parsed as HTML
  return node;
}

function renderTool(tool) {
  const card = el("article", "tool-card");
  const head = el("h3");
  head.append(el("code", null, tool.name));
  if (tool.title) head.append(el("span", "tool-title", ` · ${tool.title}`));
  card.append(head, el("p", null, tool.description));

  const props = tool.inputSchema?.properties || {};
  const required = new Set(tool.inputSchema?.required || []);
  const names = Object.keys(props);

  if (names.length) {
    const table = el("table", "params");
    const thead = el("thead");
    const hr = el("tr");
    ["Argument", "Type", "Description"].forEach((h) => hr.append(el("th", null, h)));
    thead.append(hr);
    const tbody = el("tbody");
    for (const name of names) {
      const p = props[name];
      const tr = el("tr");
      const nameCell = el("td");
      nameCell.append(el("code", null, name));
      if (required.has(name)) nameCell.append(el("span", "req", " required"));
      const type = p.enum ? p.enum.map((v) => JSON.stringify(v)).join(" | ") : p.type || "any";
      tr.append(nameCell, el("td", null, type), el("td", null, p.description || ""));
      tbody.append(tr);
    }
    table.append(thead, tbody);
    card.append(table);
  } else {
    card.append(el("p", "muted", "No arguments."));
  }

  const a = tool.annotations || {};
  const hints = [];
  if (a.readOnlyHint) hints.push("read-only");
  if (a.openWorldHint) hints.push("calls the internet");
  else if (a.openWorldHint === false) hints.push("local data only");
  if (hints.length) card.append(el("p", "hints", hints.join(" · ")));
  return card;
}

async function loadTools() {
  try {
    const res = await fetch(MCP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    const tools = data.result?.tools || [];
    tools.forEach((t) => listEl.append(renderTool(t)));
    statusEl.textContent = `Live from the MCP server: ${tools.length} tools, fetched just now with tools/list.`;
  } catch (err) {
    statusEl.textContent =
      "Couldn't reach the MCP server right now, so the live tool list isn't shown. " +
      "The tools are lookup_musician, album_lineup, search_jazz, random_jazz_fact, and chord_chart.";
    statusEl.classList.add("warn");
    console.error(err);
  }
}

loadTools();
