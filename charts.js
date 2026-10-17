// Jaizz Chat — chord-chart layout (shared by the page and the PDFs) and PDF export.
// PDFs are drawn as vector text and lines, black on white like a printed lead sheet,
// so they stay sharp at any zoom. jsPDF loads only when someone asks for a PDF.
// No secrets here: this file is public on GitHub Pages.

(function () {
  const JSPDF_URL = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
  const JSPDF_SRI = "sha384-JcnsjUPPylna1s1fvi1u12X5qjY5OL56iySh75FdtrwhO/SWXgMjoVqcKyIIWOLk";

  /* ---------- layout, shared with the on-screen chart ---------- */

  // 4 bars per row: a section letter starts a new row, and a 2nd ending starts
  // a new row indented under the 1st ending. Empty slots are null.
  function layoutRows(bars) {
    const rows = [];
    let row = [];
    let ending1Col = 0;
    let inEnding = 0;
    for (const bar of bars) {
      if (row.length && (row.length === 4 || bar.l || (bar.n || 0) >= 2)) { rows.push(row); row = []; }
      if (bar.n === 1) ending1Col = row.length;
      if ((bar.n || 0) >= 2 && row.length === 0) for (let i = 0; i < ending1Col; i++) row.push(null);
      if (bar.n) inEnding = bar.n;
      row.push({ ...bar, inEnding, endingStart: Boolean(bar.n) });
      if (["}", "]", "Z"].includes(bar.e)) inEnding = 0;
    }
    if (row.length) rows.push(row);
    return rows;
  }

  const CLOSES = ["]", "}", "Z"];

  // Chart chord symbols: maj7 → Δ7, m7 → –7, m7b5 → ø7, dim7 → o7, aug → +
  function quality(q) {
    const map = [
      [/^mMaj/, "–Δ"], [/^maj/, "Δ"], [/^m7b5$/, "ø7"], [/^m9b5$/, "ø9"],
      [/^dim7$/, "o7"], [/^dim$/, "o"], [/^aug$/, "+"], [/^m/, "–"],
    ];
    for (const [re, sub] of map) if (re.test(q)) { q = q.replace(re, sub); break; }
    return q.replace("6/9", "69").replace(/b(\d)/g, "♭$1").replace(/#(\d)/g, "♯$1");
  }

  // "Bb-7/F" style symbols → parts, or null for anything that isn't a chord (N.C. etc.).
  function parseChord(sym) {
    const m = String(sym).match(/^([A-G])([b#]?)(.*?)(?:\/([A-G])([b#]?))?$/);
    return m ? { root: m[1], acc: m[2], q: m[3], bass: m[4], bassAcc: m[5] } : null;
  }

  /* ---------- PDF ---------- */

  let jsPDFPromise = null;
  function loadJsPDF() {
    if (window.jspdf?.jsPDF) return Promise.resolve(window.jspdf.jsPDF);
    if (!jsPDFPromise) {
      jsPDFPromise = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = JSPDF_URL;
        s.integrity = JSPDF_SRI;
        s.crossOrigin = "anonymous";
        s.referrerPolicy = "no-referrer";
        s.onload = () => (window.jspdf?.jsPDF ? resolve(window.jspdf.jsPDF) : reject(new Error("PDF library didn't load")));
        s.onerror = () => { jsPDFPromise = null; s.remove(); reject(new Error("PDF library didn't load")); };
        document.head.append(s);
      });
    }
    return jsPDFPromise;
  }

  // US Letter, millimetres.
  const PAGE = { w: 215.9, h: 279.4, m: 16 };
  const PT = 0.3528; // mm per point
  const BAR_W = (PAGE.w - 2 * PAGE.m) / 4;
  const ROW_H = 15;
  const ROW_GAP = 3.5;
  const LABEL_GAP = 7;
  const THIN = 0.25;

  // The built-in PDF fonts cover Latin-1 only. ♭/♯ get drawn as glyphs where it
  // matters (chords); in titles and keys they become b/#, and anything else unknown becomes "?".
  const latin = (s) =>
    String(s ?? "")
      .replace(/♭/g, "b").replace(/♯/g, "#")
      .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/…/g, "...")
      .replace(/[^\x20-\x7e\xa0-\xff]/g, "?");

  const fileName = (s) => latin(s).replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, " ").trim().slice(0, 80) || "chart";

  /* glyphs: x = left edge, yb = baseline, h = glyph height (all mm); each returns its advance width */

  function sharp(doc, x, yb, h) {
    doc.setLineWidth(h * 0.08);
    doc.line(x + 0.25 * h, yb - 0.95 * h, x + 0.25 * h, yb + 0.12 * h);
    doc.line(x + 0.52 * h, yb - 1.05 * h, x + 0.52 * h, yb + 0.02 * h);
    doc.setLineWidth(h * 0.15);
    doc.line(x + 0.04 * h, yb - 0.6 * h, x + 0.74 * h, yb - 0.74 * h);
    doc.line(x + 0.04 * h, yb - 0.26 * h, x + 0.74 * h, yb - 0.4 * h);
    return 0.82 * h;
  }

  function flat(doc, x, yb, h) {
    const sx = x + 0.12 * h;
    doc.setLineWidth(h * 0.09);
    doc.line(sx, yb - 1.15 * h, sx, yb);
    doc.setLineWidth(h * 0.12);
    // the bowl: out to the right from mid-height, back to the foot of the stem
    doc.lines([[0.42 * h, -0.28 * h, 0.58 * h, 0.12 * h, 0, 0.46 * h]], sx, yb - 0.46 * h, [1, 1], "S");
    return 0.66 * h;
  }

  function delta(doc, x, yb, h) {
    doc.setLineWidth(h * 0.1);
    doc.triangle(x + 0.05 * h, yb, x + 0.8 * h, yb, x + 0.425 * h, yb - 0.82 * h, "S");
    return 0.92 * h;
  }

  function minusSign(doc, x, yb, h) {
    doc.setLineWidth(h * 0.13);
    doc.line(x + 0.08 * h, yb - 0.38 * h, x + 0.62 * h, yb - 0.38 * h);
    return 0.72 * h;
  }

  // Text runs plus drawn glyphs, left to right. measure=true only adds up widths.
  function drawRun(doc, str, x, yb, sizePt, measure) {
    const h = sizePt * PT * 0.72; // about cap height
    let cx = x;
    let text = "";
    const flush = () => {
      if (!text) return;
      if (!measure) doc.text(text, cx, yb);
      cx += doc.getTextWidth(text);
      text = "";
    };
    for (const ch of str) {
      const glyph = { "♭": flat, "♯": sharp, "Δ": delta, "–": minusSign }[ch];
      if (!glyph) { text += latin(ch); continue; }
      flush();
      if (measure) cx += { "♭": 0.66, "♯": 0.82, "Δ": 0.92, "–": 0.72 }[ch] * h;
      else cx += glyph(doc, cx, yb, h);
    }
    flush();
    return cx - x;
  }

  // One chord symbol at (x, yb). Returns its width.
  function drawChord(doc, sym, x, yb, size, measure) {
    const p = parseChord(sym);
    doc.setFont("helvetica", "bold");
    if (!p) {
      doc.setFontSize(size * 0.62);
      return drawRun(doc, sym, x, yb, size * 0.62, measure);
    }
    let cx = x;
    doc.setFontSize(size);
    if (!measure) doc.text(p.root, cx, yb);
    cx += doc.getTextWidth(p.root) + 0.15;
    if (p.acc) {
      const h = size * PT * 0.4;
      const raise = size * PT * 0.36;
      const w = p.acc === "b" ? 0.66 * h : 0.82 * h;
      if (!measure) (p.acc === "b" ? flat : sharp)(doc, cx, yb - raise, h);
      cx += w + 0.2;
    }
    if (p.q) {
      doc.setFontSize(size * 0.58);
      cx += drawRun(doc, quality(p.q), cx, yb, size * 0.58, measure);
    }
    let width = cx - x;
    if (p.bass) {
      doc.setFontSize(size * 0.55);
      const bassStr = "/" + p.bass + (p.bassAcc === "b" ? "♭" : p.bassAcc === "#" ? "♯" : "");
      const bw = drawRun(doc, bassStr, x + 2, yb + size * PT * 0.62, size * 0.55, measure);
      width = Math.max(width, 2 + bw);
    }
    return width;
  }

  /* barlines and marks; top/bottom are the bar's vertical extent */

  // Text and filled shapes share one PDF fill colour, so every fill resets it to black first.
  const black = (doc) => doc.setFillColor(0, 0, 0);

  function vline(doc, x, top, bottom, w = THIN) {
    doc.setLineWidth(w);
    doc.line(x, top, x, bottom);
  }
  function thick(doc, x, top, bottom) {
    black(doc);
    doc.rect(x, top, 0.9, bottom - top, "F");
  }
  function repeatDots(doc, x, top, bottom) {
    const mid = (top + bottom) / 2;
    black(doc);
    doc.circle(x, mid - 1.7, 0.42, "F");
    doc.circle(x, mid + 1.7, 0.42, "F");
  }
  function openBar(doc, kind, x, top, bottom) {
    if (kind === "[") { vline(doc, x, top, bottom); vline(doc, x + 0.8, top, bottom); return 1.4; }
    if (kind === "{") { thick(doc, x, top, bottom); vline(doc, x + 1.6, top, bottom); repeatDots(doc, x + 2.7, top, bottom); return 3.6; }
    vline(doc, x, top, bottom);
    return 0;
  }
  function closeBar(doc, kind, x, top, bottom) {
    if (kind === "]") { vline(doc, x - 0.8, top, bottom); vline(doc, x, top, bottom); return 1.4; }
    if (kind === "}") { repeatDots(doc, x - 2.7, top, bottom); vline(doc, x - 1.6, top, bottom); thick(doc, x - 0.9, top, bottom); return 3.6; }
    if (kind === "Z") { vline(doc, x - 1.6, top, bottom); thick(doc, x - 0.9, top, bottom); return 1.8; }
    vline(doc, x, top, bottom);
    return 0;
  }

  // Segno, coda and fermata, drawn small at (cx, cy). Each returns its width.
  function coda(doc, cx, cy) {
    doc.setLineWidth(0.3);
    doc.ellipse(cx, cy, 1.15, 1.45, "S");
    doc.line(cx - 2, cy, cx + 2, cy);
    doc.line(cx, cy - 2.2, cx, cy + 2.2);
    return 4.4;
  }
  function segno(doc, cx, cy) {
    doc.setFont("times", "italic");
    doc.setFontSize(12);
    doc.text("S", cx, cy + 1.5, { align: "center" });
    doc.setLineWidth(0.3);
    doc.line(cx - 1.6, cy + 1.9, cx + 1.6, cy - 2.4);
    black(doc);
    doc.circle(cx - 1.5, cy - 0.3, 0.35, "F");
    doc.circle(cx + 1.5, cy + 0.3, 0.35, "F");
    return 4.2;
  }
  function fermata(doc, cx, cy) {
    doc.setLineWidth(0.3);
    doc.lines([[0, -2.1, 3.6, -2.1, 3.6, 0]], cx - 1.8, cy + 1, [1, 1], "S");
    black(doc);
    doc.circle(cx, cy + 0.5, 0.35, "F");
    return 4.4;
  }

  function drawBar(doc, b, row, i, top) {
    const x = PAGE.m + i * BAR_W;
    const xr = x + BAR_W;
    const bottom = top + ROW_H;
    const prev = row[i - 1];
    const next = row[i + 1];

    let padL = 2.2;
    let padR = 1.6;
    if (!(prev && CLOSES.includes(prev.e))) padL += openBar(doc, b.o, x, top, bottom);
    if (CLOSES.includes(b.e)) padR += closeBar(doc, b.e, xr, top, bottom);
    else if (i === 3 || !next) vline(doc, xr, top, bottom);

    if (b.inEnding) {
      doc.setLineWidth(THIN);
      doc.line(x, top - 1.6, xr - (CLOSES.includes(b.e) ? 0 : 0.8), top - 1.6);
      if (b.endingStart) {
        doc.line(x, top - 1.6, x, top + 2.6);
        doc.setFont("helvetica", "bold");
        doc.setFontSize(7.5);
        doc.text(`${b.n}.`, x + 1.2, top + 2);
      }
    }

    if (b.l) {
      doc.setFont("helvetica", "bold");
      doc.setFontSize(8.5);
      const w = Math.max(4.6, doc.getTextWidth(b.l) + 1.8);
      black(doc);
      doc.rect(x - 0.4, top - 6.2, w, 4.6, "F");
      doc.setTextColor(255, 255, 255);
      doc.text(b.l, x - 0.4 + w / 2, top - 2.7, { align: "center" });
      doc.setTextColor(0, 0, 0);
    }

    if (b.t) {
      const [t1, t2] = String(b.t).split("/");
      doc.setFont("helvetica", "bold");
      doc.setFontSize(8.5);
      const mid = top + ROW_H / 2;
      const tx = x + padL + 0.8;
      doc.text(t1 || "", tx, mid - 0.4, { align: "center" });
      doc.text(t2 || "", tx, mid + 2.8, { align: "center" });
      padL += 3.4;
    }

    const marks = [b.f && fermata, b.q && coda, b.s && segno].filter(Boolean);
    let mx = xr - padR - 1.6;
    for (const mark of marks) mx -= mark(doc, mx, top + 3.2) + 0.8;

    const yb = top + ROW_H * 0.6;
    if (b.r) {
      doc.setFont("helvetica", "bold");
      doc.setFontSize(17);
      const cx = x + BAR_W / 2;
      doc.text("%", cx, yb + 1, { align: "center" });
      if (b.r === "%2") {
        doc.setFontSize(8);
        doc.text("2", cx + 3, yb - 3.2);
      }
    } else {
      const chords = b.c || [];
      const avail = BAR_W - padL - padR;
      const slot = avail / Math.max(1, chords.length);
      chords.forEach((sym, k) => {
        let size = 15;
        while (size > 8 && drawChord(doc, sym, 0, 0, size, true) > slot - 1) size -= 0.5;
        drawChord(doc, sym, x + padL + k * slot, yb, size, false);
      });
    }

    if (b.m) {
      doc.setFont("helvetica", "oblique");
      doc.setFontSize(7);
      doc.text(latin(b.m), x + padL, bottom - 0.9, { maxWidth: BAR_W - padL - padR });
    }
  }

  function drawHeader(doc, chart, cont) {
    doc.setTextColor(0, 0, 0);
    if (cont) {
      doc.setFont("helvetica", "bold");
      doc.setFontSize(11);
      doc.text(`${latin(chart.title)} (continued)`, PAGE.m, PAGE.m + 4);
      return PAGE.m + 10;
    }
    const top = PAGE.m + 7;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(21);
    doc.text(latin(chart.title), PAGE.w / 2, top, { align: "center", maxWidth: PAGE.w - 2 * PAGE.m - 60 });
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9.5);
    if (chart.style) doc.text(`(${latin(chart.style)})`, PAGE.m, top);
    if (chart.composer && chart.composer !== "unknown") doc.text(latin(chart.composer), PAGE.w - PAGE.m, top, { align: "right" });
    const sub = [chart.key, chart.form].filter(Boolean).map(latin).join("  ·  ");
    if (sub) {
      doc.setFontSize(9);
      doc.setTextColor(90, 90, 90);
      doc.text(sub, PAGE.w / 2, top + 6, { align: "center" });
      doc.setTextColor(0, 0, 0);
    }
    return top + 12;
  }

  function drawChart(doc, chart) {
    let y = drawHeader(doc, chart, false);
    for (const row of layoutRows(chart.bars || [])) {
      const labelled = row.some((b) => b && b.l);
      const gap = labelled ? LABEL_GAP : ROW_GAP;
      if (y + gap + ROW_H > PAGE.h - PAGE.m - 6) {
        doc.addPage();
        y = drawHeader(doc, chart, true);
      }
      const top = y + gap;
      row.forEach((b, i) => { if (b) drawBar(doc, b, row, i, top); });
      y = top + ROW_H;
    }
  }

  function drawSetlistCover(doc, name, charts) {
    let y = PAGE.m + 8;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(24);
    doc.text(latin(name), PAGE.m, y);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(90, 90, 90);
    const when = new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
    doc.text(`${charts.length} tune${charts.length === 1 ? "" : "s"}  ·  ${latin(when)}`, PAGE.m, y + 7);
    doc.setTextColor(0, 0, 0);
    y += 18;
    charts.forEach((c, i) => {
      if (y > PAGE.h - PAGE.m - 8) { doc.addPage(); y = PAGE.m + 6; }
      doc.setFont("helvetica", "bold");
      doc.setFontSize(13);
      doc.text(`${i + 1}.`, PAGE.m + 8, y, { align: "right" });
      doc.text(latin(c.title), PAGE.m + 11, y, { maxWidth: 110 });
      doc.setFont("helvetica", "normal");
      doc.setFontSize(10);
      doc.setTextColor(90, 90, 90);
      doc.text([c.key, c.style].filter(Boolean).map(latin).join("  ·  "), PAGE.w - PAGE.m, y, { align: "right" });
      doc.setTextColor(0, 0, 0);
      doc.setDrawColor(200, 200, 200);
      doc.setLineWidth(0.2);
      doc.line(PAGE.m, y + 3, PAGE.w - PAGE.m, y + 3);
      doc.setDrawColor(0, 0, 0);
      y += 10;
    });
  }

  function pageNumbers(doc, label) {
    const n = doc.getNumberOfPages();
    if (n < 2) return;
    for (let p = 1; p <= n; p++) {
      doc.setPage(p);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      doc.setTextColor(120, 120, 120);
      doc.text(`${latin(label)}  ·  page ${p} of ${n}`, PAGE.w / 2, PAGE.h - 8, { align: "center" });
      doc.setTextColor(0, 0, 0);
    }
  }

  // charts: [{ title, composer, key, form, style, bars }]. With setlistName, adds a cover page.
  async function buildPdf(charts, { setlistName } = {}) {
    const JsPDF = await loadJsPDF();
    const doc = new JsPDF({ unit: "mm", format: "letter", orientation: "portrait" });
    doc.setDrawColor(0, 0, 0);
    doc.setFillColor(0, 0, 0);
    let first = true;
    const next = () => { if (!first) doc.addPage(); first = false; };
    if (setlistName) { next(); drawSetlistCover(doc, setlistName, charts); }
    for (const chart of charts) { next(); drawChart(doc, chart); }
    pageNumbers(doc, setlistName || charts[0]?.title || "");
    doc.setProperties({ title: latin(setlistName || charts[0]?.title || "Chart"), creator: "Jaizz Chat" });
    return doc;
  }

  async function downloadChart(chart) {
    const doc = await buildPdf([chart]);
    doc.save(`${fileName(`${chart.title}${chart.key ? ` (${chart.key})` : ""}`)}.pdf`);
  }

  async function downloadSetlist(name, charts) {
    const doc = await buildPdf(charts, { setlistName: name || "Setlist" });
    doc.save(`${fileName(name || "Setlist")}.pdf`);
  }

  window.ChartSheet = { layoutRows, quality, parseChord, buildPdf, downloadChart, downloadSetlist };
})();
