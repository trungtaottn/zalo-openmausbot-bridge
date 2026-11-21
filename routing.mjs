// Routing of the bot's outgoing text to Zalo channels. Pure helpers, no I/O.
//
// The bot marks each part of an answer with a marker line of its own:
//   [[nhóm #<mã>]]   → the customer group
//   [[riêng #<mã>]]  → the owner's private Zalo DM
//   [[nội bộ #<mã>]] → the internal group
// Accent-less spellings (nhom, rieng, noi bo, noibo) are accepted, "#" and the
// request code are optional. A line only counts as a marker when it holds
// nothing else; text before the first marker line is unmarked (dest null).

const MARKER = /^\s*\[\[\s*(nh[oó]m|ri[eê]ng|n[oộ]i\s*b[oộ])\s*(?:#?\s*(\w+))?\s*\]\]\s*$/iu;
const DEST_OF = { nhom: "group", rieng: "owner", noibo: "internal" };

const markerDest = (word) =>
  DEST_OF[word.normalize("NFD").replace(/\p{M}+/gu, "").replace(/\s+/g, "").toLowerCase()] || null;

// Splits a bot text into segments. Returns [{ dest, code, body }] where dest is
// "group" | "owner" | "internal" | null (unmarked), code the request code or
// null, body the trimmed text with marker lines removed. Empty segments drop.
export function splitMarked(text) {
  const t = (text || "").normalize("NFC");
  const out = [];
  let dest = null;
  let code = null;
  let body = [];
  const flush = () => {
    const b = body.join("\n").trim();
    if (b) out.push({ dest, code, body: b });
  };
  for (const line of t.split("\n")) {
    const m = line.match(MARKER);
    if (m) {
      flush();
      dest = markerDest(m[1]);
      code = m[2] || null;
      body = [];
    } else {
      body.push(line);
    }
  }
  flush();
  return out;
}

// Decides what of a turn's assistant texts reaches Zalo. When any segment of
// the turn is marked, only marked segments are dispatched (mode "marked");
// otherwise the LAST text alone goes to the command's own channel (mode
// "last"). mode "none": nothing to post.
export function planAnswers(texts) {
  const list = texts || [];
  const segments = list.flatMap((t) => splitMarked(t));
  if (segments.some((s) => s.dest)) return { mode: "marked", segments };
  const last = [...list].reverse().find((t) => typeof t === "string" && t.trim());
  return last ? { mode: "last", body: last, segments } : { mode: "none", segments };
}

// Legacy check for watches created before markers were required: a "[[nhóm]]"
// marker counts only at the very start of the text.
const LEAD_GROUP = /^\s*\[\[\s*nh(?:o|ó)m\s*(?:#?\s*(\w+))?\s*\]\][ \t]*\n?/iu;
export function leadGroupMark(text) {
  const t = (text || "").normalize("NFC");
  const m = t.match(LEAD_GROUP);
  return m ? { marked: true, code: m[1] || null, body: t.slice(m[0].length) } : { marked: false, code: null, body: t };
}
