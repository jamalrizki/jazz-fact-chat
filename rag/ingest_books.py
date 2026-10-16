#!/usr/bin/env python3
"""
Turn the reference material into retrieval chunks for the search_theory_books tool.

    python3 rag/ingest_books.py              # every source in rag/books.json that is ready
    python3 rag/ingest_books.py src-a src-b  # only these source ids

Run from the repo root. Reads "reference/" (gitignored), writes knowledge/chunks.jsonl
and knowledge/report.txt (also gitignored).

  * Text PDFs: pdftotext, one page at a time.
  * Scanned PDFs ("ocr": true): read page text from knowledge/ocr/<id>/page-NNNN.txt,
    written by rag/ocr_books.sh. Skipped until that exists.
  * EPUB: chapters in reading order; epubs have no fixed pages, so citations use chapters.

Why the work is in code: citations must be right, so printed page numbers are detected
here (PDF page 200 can be printed page 184) rather than left to the model.
"""
import html, json, re, statistics, subprocess, sys, zipfile
from collections import Counter
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BOOKS_DIR = ROOT / "reference"
OUT_DIR = ROOT / "knowledge"
TARGET_WORDS = 300   # ~400 tokens; 3-4 chunks per answer must fit Groq's 8k tokens/minute
MAX_WORDS = 400
OVERLAP_WORDS = 50   # repeat the tail of a chunk so an idea split across a boundary survives
MIN_CHUNK_WORDS = 60

# ---------- page text sources ----------

def pdf_pages(path):
    out = subprocess.run(["pdftotext", "-enc", "UTF-8", str(path), "-"],
                         capture_output=True, text=True, errors="replace").stdout
    pages = out.split("\f")
    if pages and not pages[-1].strip():
        pages.pop()
    return pages

def ocr_pages(book_id):
    d = OUT_DIR / "ocr" / book_id
    files = sorted(d.glob("page-*.txt"))
    return [f.read_text(errors="replace") for f in files] if files else None

PAGE_MARK = "\x00PAGE:{}\x00"
PAGE_MARK_RE = re.compile(r"\x00PAGE:(\d+)\x00")

class _Text(HTMLParser):
    """XHTML -> text. Keeps printed-page anchors (<a id="page_12"/>) as markers and
    collects the h1/h2 texts that make up the chapter title ("1" + "The Prehistory of Jazz")."""
    BLOCK = {"p", "div", "h1", "h2", "h3", "h4", "li", "blockquote", "br", "tr"}
    def __init__(self):
        super().__init__(); self.parts = []; self.titles = []; self._in_h = False; self._skip = 0
    @property
    def heading(self):
        t = [x for x in self.titles if x]
        if len(t) >= 2 and t[0].isdigit(): return f"Ch. {t[0]}: {' '.join(t[1:])}"
        return " ".join(t) or None
    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"): self._skip += 1
        m = re.fullmatch(r"page_?(\d+)", dict(attrs).get("id") or "")
        if m: self.parts.append(PAGE_MARK.format(m.group(1)))
        if tag in ("h1", "h2"): self._in_h = True; self._h = []
        if tag in self.BLOCK: self.parts.append("\n\n")
    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
    def handle_endtag(self, tag):
        if tag in ("script", "style"): self._skip -= 1
        if tag in ("h1", "h2") and self._in_h:
            self._in_h = False; self.titles.append(" ".join("".join(self._h).split()))
        if tag in self.BLOCK: self.parts.append("\n\n")
    def handle_data(self, data):
        if self._skip: return
        self.parts.append(data)
        if self._in_h: self._h.append(data)

SKIP_EPUB = re.compile(r"cover|halftitle|series|titlepage|copyright|dedication|contents|notes|bibliograph|other|acknowledg|index|nav", re.I)

def epub_chapters(path):
    z = zipfile.ZipFile(path)
    opf_path = re.search(r'full-path="([^"]+)"', z.read("META-INF/container.xml").decode()).group(1)
    opf = z.read(opf_path).decode("utf-8", "replace")
    base = opf_path.rsplit("/", 1)[0] + "/" if "/" in opf_path else ""
    manifest = dict(re.findall(r'<item\b[^>]*\bid="([^"]+)"[^>]*\bhref="([^"]+)"', opf))
    manifest.update({i: h for h, i in re.findall(r'<item\b[^>]*\bhref="([^"]+)"[^>]*\bid="([^"]+)"', opf)})
    for idref in re.findall(r'<itemref\b[^>]*\bidref="([^"]+)"', opf):
        href = manifest.get(idref)
        if not href or SKIP_EPUB.search(href.rsplit("/", 1)[-1]): continue
        p = _Text(); p.feed(z.read(base + href).decode("utf-8", "replace"))
        yield (p.heading or href), html.unescape("".join(p.parts))

# ---------- cleaning ----------

PAGE_NUM = re.compile(r"^\s*(\d{1,4})\s*$|^\s*(\d{1,4})\s{2,}\S|\S\s{2,}(\d{1,4})\s*$")

def edge_lines(text, n=3):
    lines = [l for l in text.splitlines() if l.strip()]
    return lines[:n] + lines[-n:]

def page_offsets(pages, window=12):
    """Per-page (pdf_index - printed_number). A page uses the offset most often seen within
    `window` pages of it, if at least 3 nearby pages agree; this follows numbering that shifts
    partway through a book (inserted plates, a missing scan) instead of assuming one offset.
    Returns {pdf_index: offset}; pages without enough agreement are left out."""
    found = {}
    for i, t in enumerate(pages, start=1):
        for line in edge_lines(t):
            m = PAGE_NUM.search(line)
            if m:
                n = int(next(g for g in m.groups() if g))
                if 0 < n <= i: found.setdefault(i, []).append(i - n)
    offsets = {}
    for i in range(1, len(pages) + 1):
        near = Counter(d for j in range(i - window, i + window + 1) for d in found.get(j, []))
        if near:
            off, votes = near.most_common(1)[0]
            if votes >= 3: offsets[i] = off
    return offsets

def norm_header(line):
    return re.sub(r"\d+", "", line).strip().lower()

def running_headers(pages):
    c = Counter()
    for t in pages:
        lines = [l for l in t.splitlines() if l.strip()]
        for l in set(lines[:3] + lines[-3:]):
            h = norm_header(l)
            if 2 <= len(h) <= 90: c[h] += 1
    return {h for h, n in c.items() if n >= max(4, 0.03 * len(pages))}

def clean_page(text, headers, book_title=""):
    """Drop page numbers / running headers; rebuild paragraphs from wrapped lines.
    Returns (paragraphs, header_text_seen)."""
    lines = text.splitlines()
    nonblank = [i for i, l in enumerate(lines) if l.strip()]
    edges = set(nonblank[:3] + nonblank[-3:])
    title_norm = norm_header(book_title)
    # "Chapter 2" in the header: the next edge line is the chapter title, even when the
    # chapter is too short for that title to count as a repeating running header.
    chapter_title_idx = set()
    for k, i in enumerate(nonblank):
        if i in edges and re.fullmatch(r"\s*chapter\s+\d+\s*", lines[i], re.I) and k + 1 < len(nonblank):
            j = nonblank[k + 1]
            if j in edges and not re.fullmatch(r"\s*\d{1,4}\s*", lines[j]): chapter_title_idx.add(j)
    header_parts = []
    kept = []
    for i, l in enumerate(lines):
        if i in edges and (norm_header(l) in headers or i in chapter_title_idx
                           or norm_header(l) == title_norm or re.fullmatch(r"\s*\d{1,4}\s*", l)):
            # drop a page number glued to the header ("20   Chapter 2"), keep "Chapter 2" itself
            h = re.sub(r"\s{2,}", " ", re.sub(r"^\s*\d+\s{2,}|\s{2,}\d+\s*$", "", l)).strip()
            if h and not h.isdigit() and norm_header(h) != title_norm and len(h) > 2: header_parts.append(h)
            continue
        kept.append(l.rstrip())
    seen_header = " — ".join(header_parts) or None
    paras, cur = [], []
    for l in kept + [""]:
        if l.strip():
            cur.append(l.strip())
        elif cur:
            p = cur[0]
            for nxt in cur[1:]:
                p = p[:-1] + nxt if re.search(r"[a-z]-$", p) and nxt[:1].islower() else p + " " + nxt
            paras.append(re.sub(r"\s+", " ", p)); cur = []
    return paras, seen_header

def prose_ratio(text):
    words = text.split()
    if not words: return 0
    return sum(1 for w in words if re.fullmatch(r"[A-Za-z][a-z'’]+[.,;:!?)\"”]*", w)) / len(words)

EN_WORDS = re.compile(r"\b(the|and|of|is|that|with|this|are|for|to|in|it)\b", re.I)
OTHER_WORDS = re.compile(r"\b(il|della|delle|che|nella|sono|scala|per|una|questo|degli|le|la|di|del)\b", re.I)

def mostly_english(text):
    """The embedding model and the app are English; some editions are bilingual."""
    return len(EN_WORDS.findall(text)) >= 2 * len(OTHER_WORDS.findall(text))

def citation(c):
    """Built in code so the model never has to work out (or invent) a page reference."""
    parts = [c["author"], c["book"]]
    if c["section"]: parts.append(c["section"])
    if c["page"]:
        # a chunk that skips pages of notation would read "pp. 83-93"; cite where the passage starts
        span = (c["page_end"] or c["page"]) - c["page"]
        parts.append(f'pp. {c["page"]}-{c["page_end"]}' if span in (1, 2) else f'p. {c["page"]}')
    elif c["pdf_page"]:
        parts.append(f'PDF page {c["pdf_page"]}')
    return ", ".join(parts)

BACK_MATTER = re.compile(r"^(notes to pages|notes$|bibliography|references$|index|discography|permissions|credits)", re.I)

SENT = re.compile(r"(?:(?<=[.!?])|(?<=[.!?][\"”’)]))\s+(?=[A-Z“\"(])")

# ---------- chunking ----------

def chunk_units(units):
    """units: (sentence, page, section, paragraph_end). Packs sentences into ~TARGET_WORDS chunks."""
    chunks, cur, words = [], [], 0
    def flush():
        nonlocal cur, words
        if not cur: return
        text = " ".join(u[0] for u in cur)
        chunks.append({"text": text, "page_start": cur[0][1], "page_end": cur[-1][1],
                       "section": next((u[2] for u in reversed(cur) if u[2]), None)})
        tail, n = [], 0
        for u in reversed(cur):
            n += len(u[0].split())
            if n > OVERLAP_WORDS: break
            tail.insert(0, u)
        cur, words = tail, sum(len(u[0].split()) for u in tail)
    for u in units:
        w = len(u[0].split())
        if words and words + w > MAX_WORDS: flush()
        cur.append(u); words += w
        if words >= TARGET_WORDS and (u[3] or words >= TARGET_WORDS + 60): flush()
    if words > OVERLAP_WORDS: flush()
    return chunks

# Music-font glyphs from notated examples survive text extraction as junk ("˙˙ w w b˙").
NOTATION_TOKEN = re.compile(r"^(?:\S*[˙œÓ∑Œ‰≈‹¿æ]\S*|[w&?]+)$")

def strip_notation(p):
    return re.sub(r"\s+", " ", " ".join(t for t in p.split() if not NOTATION_TOKEN.match(t))).strip()

def units_from_paragraphs(paras, page, section):
    for p in map(strip_notation, paras):
        if not p: continue
        sents = [s for s in SENT.split(p) if s.strip()]
        # an over-long "sentence" (tables, run-ons) is cut into word windows
        out = []
        for s in sents:
            ws = s.split()
            out += [" ".join(ws[i:i + MAX_WORDS // 2]) for i in range(0, len(ws), MAX_WORDS // 2)]
        for k, s in enumerate(out):
            yield (s, page, section, k == len(out) - 1)

def tidy_chapter_sections(chunks):
    """Header areas also hold example labels ("9.17", "Gm7", "XIII."). Give every
    "Chapter N ..." section the one title most often seen for chapter N."""
    def is_title(part):
        return len(re.findall(r"[A-Za-z]{3,}", part)) >= 2 and not re.match(r"^(\d|[IVXLC]+\s*\.)", part.strip())
    votes = {}
    for c in chunks:
        m = re.match(r"chapter\s+(\d+)", c["section"] or "", re.I)
        if m:
            for part in c["section"].split(" — ")[1:]:
                if is_title(part): votes.setdefault(m.group(1), Counter())[part] += 1
    for c in chunks:
        m = re.match(r"chapter\s+(\d+)", c["section"] or "", re.I)
        if m:
            best = votes.get(m.group(1))
            c["section"] = f"Chapter {m.group(1)}" + (f": {best.most_common(1)[0][0]}" if best else "")
    return chunks

# ---------- per book ----------

def ingest(book):
    path = BOOKS_DIR / book["file"]
    stats = {"id": book["id"], "pages": 0, "kept_pages": 0}
    if book["file"].endswith(".epub"):
        units, page, anchors = [], None, 0
        for heading, text in epub_chapters(path):
            stats["pages"] += 1
            for raw in text.split("\n\n"):
                start = page
                marks = PAGE_MARK_RE.findall(raw)
                if marks:
                    anchors += len(marks)
                    # a paragraph that opens with a page anchor belongs to that page
                    if PAGE_MARK_RE.match(raw.strip()): start = int(marks[0])
                    page = int(marks[-1])
                para = re.sub(r"\s+", " ", PAGE_MARK_RE.sub(" ", raw)).strip()
                if len(para.split()) >= 4:
                    units += units_from_paragraphs([para], {"pdf": None, "printed": start}, heading)
        stats["kept_pages"] = stats["pages"]
        stats["page_note"] = f"epub: {anchors} printed-page anchors" if anchors else "epub: cited by chapter"
    else:
        pages = ocr_pages(book["id"]) if book.get("ocr") else pdf_pages(path)
        if pages is None:
            return [], dict(stats, skipped="needs OCR first (rag/ocr_books.sh)")
        stats["pages"] = len(pages)
        offsets = page_offsets(pages)
        common = Counter(offsets.values()).most_common(2)
        stats["page_note"] = (f"printed pages on {len(offsets)}/{len(pages)} pages; offsets " + ", ".join(f"-{o} x{n}" for o, n in common)
                              if offsets else "no printed page numbers found; citing PDF pages")
        headers = running_headers(pages)
        units, section = [], None
        for i, t in enumerate(pages, start=1):
            paras, h = clean_page(t, headers, book["title"])
            # OCR garbles running headers ("CHarrer Teo"), so scanned books are cited by page only
            if h and h.lower() != book["title"].lower() and not book.get("ocr"): section = h
            if section and BACK_MATTER.search(section): continue
            body = " ".join(paras)
            if len(body.split()) < 25 or prose_ratio(body) < 0.5:
                continue   # notation, tables, blank or front-matter pages
            stats["kept_pages"] += 1
            printed = i - offsets[i] if i in offsets and i - offsets[i] > 0 else None
            units += units_from_paragraphs(paras, {"pdf": i, "printed": printed}, section)
    chunks = []
    stats["dropped_lang"] = 0
    for n, c in enumerate(chunk_units(units)):
        if len(c["text"].split()) < MIN_CHUNK_WORDS or prose_ratio(c["text"]) < 0.55: continue
        if not mostly_english(c["text"]):
            stats["dropped_lang"] += 1; continue
        ps, pe = c["page_start"], c["page_end"]
        chunks.append({
            "id": f'{book["id"]}-{n:04d}', "book_id": book["id"], "book": book["title"], "author": book["author"],
            "section": c["section"],
            "page": (ps or {}).get("printed"), "page_end": (pe or {}).get("printed"),
            "pdf_page": (ps or {}).get("pdf"),
            "words": len(c["text"].split()), "text": c["text"],
        })
        chunks[-1]["cite"] = citation(chunks[-1])
    tidy_chapter_sections(chunks)
    stats["chunks"] = len(chunks)
    stats["words"] = sum(c["words"] for c in chunks)
    return chunks, stats

def main(ids):
    books = json.loads((ROOT / "rag" / "books.json").read_text())
    if ids: books = [b for b in books if b["id"] in ids]
    OUT_DIR.mkdir(exist_ok=True)
    out_path = OUT_DIR / "chunks.jsonl"
    # keep chunks of books not re-ingested this run
    keep = []
    if ids and out_path.exists():
        keep = [l for l in out_path.read_text().splitlines() if l and json.loads(l)["book_id"] not in ids]
    report, new = [], []
    for b in books:
        chunks, s = ingest(b)
        new += [json.dumps(c, ensure_ascii=False) for c in chunks]
        line = f'{s["id"]:<18} ' + (f'SKIPPED: {s["skipped"]}' if "skipped" in s else
               f'pages {s["kept_pages"]}/{s["pages"]} kept, {s["chunks"]} chunks, {s["words"]:,} words'
               + (f', {s["dropped_lang"]} non-English dropped' if s.get("dropped_lang") else "") + f'  ({s["page_note"]})')
        print(line); report.append(line)
    out_path.write_text("\n".join(keep + new) + "\n")
    total = len(keep) + len(new)
    tail = f"total chunks in {out_path.relative_to(ROOT)}: {total}"
    print(tail); (OUT_DIR / "report.txt").write_text("\n".join(report + [tail]) + "\n")

if __name__ == "__main__":
    main(set(sys.argv[1:]))
