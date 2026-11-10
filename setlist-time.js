// Jaizz Chat — setlist timer: "how long is this set?"
// Pure page code, no tool call and no model: the setlist already holds each chart's form,
// so tempo × choruses × bars is plain arithmetic, done here and tested in worker/test/.
// It's an estimate ("~"): head in + solo choruses + head out, no intros, endings or talking.
// No secrets here: this file is public on GitHub Pages.

(function (root) {
  const BPM_MIN = 40, BPM_MAX = 400;
  const CHORUSES_MIN = 0, CHORUSES_MAX = 20;
  const MAX_BARS = 512; // a sanity cap on bars per chorus

  // A whole number in [min, max] from an input value ("150" or 150), else null.
  function whole(value, min, max) {
    const s = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
    if (!/^\d{1,4}$/.test(s)) return null;
    const n = Number(s);
    return n >= min && n <= max ? n : null;
  }

  // Bars in one chorus, repeats played out. The chart tool sends it as chorus_bars; charts saved
  // before that existed fall back to the form text ("AABA, 32 bars", "12-bar blues"), then to the
  // written bars if the chart has no repeat signs or endings. Otherwise null (untimed).
  function chorusBars(chart) {
    if (!chart) return null;
    const cb = chart.chorus_bars;
    if (Number.isInteger(cb) && cb >= 1 && cb <= MAX_BARS) return cb;
    const m = typeof chart.form === "string" && chart.form.match(/\b(\d{1,3})[\s-]bars?\b/i);
    if (m) { const n = Number(m[1]); if (n >= 1 && n <= MAX_BARS) return n; }
    const bars = Array.isArray(chart.bars) ? chart.bars : [];
    const repeats = bars.some((b) => b && (b.n || b.o === "{" || b.e === "}"));
    return bars.length && bars.length <= MAX_BARS && !repeats ? bars.length : null;
  }

  // Beats per bar, counted at the tempo players quote: quarter notes (3/4 → 3, 2/2 → 4,
  // 7/8 → 3.5), except 6/8, 9/8 and 12/8, which are counted in dotted quarters (2, 3, 4).
  // From the chart's first time signature; 4/4 if it has none or it can't be read.
  function beatsPerBar(chart) {
    const bars = chart && Array.isArray(chart.bars) ? chart.bars : [];
    const t = bars.find((b) => b && typeof b.t === "string");
    const m = t && t.t.match(/^(\d{1,2})\/(2|4|8|16)$/);
    if (!m) return 4;
    const num = Number(m[1]), den = Number(m[2]);
    if (num < 1) return 4;
    if (den === 8 && num % 3 === 0 && num >= 6) return num / 3;
    return (num * 4) / den;
  }

  // Seconds for one tune: (head in + choruses + head out) × bars × beats ÷ BPM. null = untimed.
  function tuneSeconds(chart, bpmIn, chorusesIn) {
    const bpm = whole(bpmIn, BPM_MIN, BPM_MAX);
    const choruses = whole(chorusesIn, CHORUSES_MIN, CHORUSES_MAX);
    const bars = chorusBars(chart);
    if (bpm === null || choruses === null || bars === null) return null;
    return ((choruses + 2) * bars * beatsPerBar(chart) * 60) / bpm;
  }

  // The whole set: { seconds, timed, untimed }. Tunes that can't be timed are left out and counted.
  function setSeconds(charts) {
    let seconds = 0, timed = 0, untimed = 0;
    for (const c of Array.isArray(charts) ? charts : []) {
      const s = tuneSeconds(c, c && c.bpm, c && c.choruses);
      if (s === null) untimed++;
      else { seconds += s; timed++; }
    }
    return { seconds, timed, untimed };
  }

  // 204.8 → "3:25"; null → "—".
  function clock(seconds) {
    if (typeof seconds !== "number" || !isFinite(seconds) || seconds < 0) return "—";
    const s = Math.round(seconds);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }

  // The total line under the setlist.
  function totalLine({ seconds, timed, untimed }) {
    if (!timed) return untimed ? "Add a tempo and choruses to each tune to time the set." : "";
    const min = Math.round(seconds / 60);
    const len = min >= 60 ? `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")} min` : `${min} min`;
    const rest = untimed ? ` · ${untimed} ${untimed === 1 ? "tune" : "tunes"} untimed` : "";
    return `Set length ~${len}${rest}`;
  }

  root.SetlistTime = {
    BPM_MIN, BPM_MAX, CHORUSES_MIN, CHORUSES_MAX,
    whole, chorusBars, beatsPerBar, tuneSeconds, setSeconds, clock, totalLine,
  };
})(typeof window !== "undefined" ? window : globalThis);
