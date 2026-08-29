/**
 * Thai spoken-time normalisation.
 *
 * People dictating a care plan say "บ่ายโมง", "ตีสอง", "ทุ่มนึง" — never "13:00". The model is
 * asked to convert these, but conversion is not left to it alone: a wrong time in a care plan
 * means medication at the wrong hour, so every time the model returns is re-checked here, and any
 * time expression it missed is recovered from the original sentence deterministically.
 *
 * The reading used is modern colloquial Thai, which is what people actually say:
 *   ตี 1–5            01:00–05:00
 *   6–11 โมงเช้า      06:00–11:00        ("โมงเช้า" alone → 07:00)
 *   เที่ยง / เที่ยงวัน  12:00
 *   บ่ายโมง            13:00
 *   บ่าย 2–5          14:00–17:00
 *   4–6 โมงเย็น       16:00–18:00        ("โมงเย็น" alone → 18:00)
 *   1–5 ทุ่ม           19:00–23:00        ("ทุ่ม" alone → 19:00)
 *   เที่ยงคืน           00:00
 */

const THAI_DIGITS = { '๐': 0, '๑': 1, '๒': 2, '๓': 3, '๔': 4, '๕': 5, '๖': 6, '๗': 7, '๘': 8, '๙': 9 };

const WORD_NUMBERS = {
  ศูนย์: 0, หนึ่ง: 1, นึง: 1, เอ็ด: 1, สอง: 2, ยี่: 2, สาม: 3, สี่: 4, ห้า: 5,
  หก: 6, เจ็ด: 7, แปด: 8, เก้า: 9, สิบ: 10, สิบเอ็ด: 11, สิบสอง: 12,
};

const NUM = `(?:\\d{1,2}|${Object.keys(WORD_NUMBERS).sort((a, b) => b.length - a.length).join('|')})`;

function toNumber(token) {
  if (token == null) return null;
  const t = String(token).trim();
  if (!t) return null;
  const arabic = t.replace(/[๐-๙]/g, (d) => THAI_DIGITS[d]);
  if (/^\d{1,2}$/.test(arabic)) return Number(arabic);
  return WORD_NUMBERS[t] ?? null;
}

const hhmm = (h, m = 0) =>
  `${String(((h % 24) + 24) % 24).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

/**
 * Rules are ordered most-specific first: "บ่ายโมง" must win before a bare "โมง" rule sees it,
 * and "โมงเย็น" before "โมง".
 */
const RULES = [
  // เที่ยงคืน / เที่ยงวัน
  //
  // Thai is written without spaces, so a word boundary cannot be expressed as "not a Thai letter":
  // in "เที่ยงป้อนข้าว" the ป immediately follows the time and such a guard would reject it.
  // Ordering plus the overlap check does the disambiguation instead — เที่ยงคืน claims its span
  // first, so the bare เที่ยง rule can never fire inside it. เที่ยงธรรม is excluded by name
  // because it is a word, not a time.
  { re: /เที่ยงคืน/g, at: () => hhmm(0) },
  { re: /เที่ยงธรรม/g, at: () => null },
  { re: /เที่ยงตรง|เที่ยงวัน|เที่ยง/g, at: () => hhmm(12) },

  // ตี 1–5  → 01:00–05:00
  { re: new RegExp(`ตี\\s*(${NUM})(?:\\s*(?:ครึ่ง))?`, 'g'),
    at: (m) => { const h = toNumber(m[1]); return h == null ? null : hhmm(h, /ครึ่ง/.test(m[0]) ? 30 : 0); } },

  // บ่ายโมง / บ่าย N โมง
  { re: /บ่าย\s*โมง(?:\s*ครึ่ง)?/g, at: (m) => hhmm(13, /ครึ่ง/.test(m[0]) ? 30 : 0) },
  { re: new RegExp(`บ่าย\\s*(${NUM})\\s*(?:โมง)?(?:\\s*ครึ่ง)?`, 'g'),
    at: (m) => { const h = toNumber(m[1]); if (h == null) return null;
      return hhmm(h >= 1 && h <= 5 ? h + 12 : h, /ครึ่ง/.test(m[0]) ? 30 : 0); } },

  // N ทุ่ม → 19:00 + (N-1)
  { re: new RegExp(`(${NUM})\\s*ทุ่ม(?:\\s*ครึ่ง)?`, 'g'),
    at: (m) => { const n = toNumber(m[1]); if (n == null) return null;
      return hhmm(18 + n, /ครึ่ง/.test(m[0]) ? 30 : 0); } },
  { re: /(?<![ก-๙\d])ทุ่ม(?:\s*ครึ่ง)?/g, at: (m) => hhmm(19, /ครึ่ง/.test(m[0]) ? 30 : 0) },

  // N โมงเย็น → 16:00–18:00
  { re: new RegExp(`(${NUM})\\s*โมง\\s*เย็น(?:\\s*ครึ่ง)?`, 'g'),
    at: (m) => { const h = toNumber(m[1]); if (h == null) return null;
      return hhmm(h <= 6 ? h + 12 : h, /ครึ่ง/.test(m[0]) ? 30 : 0); } },
  { re: /(?<![ก-๙\d])โมง\s*เย็น(?:\s*ครึ่ง)?/g, at: (m) => hhmm(18, /ครึ่ง/.test(m[0]) ? 30 : 0) },

  // N โมงเช้า → as spoken (modern colloquial: "8 โมงเช้า" = 08:00)
  { re: new RegExp(`(${NUM})\\s*โมง\\s*เช้า(?:\\s*ครึ่ง)?`, 'g'),
    at: (m) => { const h = toNumber(m[1]); if (h == null) return null;
      return hhmm(h, /ครึ่ง/.test(m[0]) ? 30 : 0); } },
  { re: /(?<![ก-๙\d])โมง\s*เช้า(?:\s*ครึ่ง)?/g, at: (m) => hhmm(7, /ครึ่ง/.test(m[0]) ? 30 : 0) },

  // bare "N โมง" — morning unless the number only makes sense in the afternoon
  { re: new RegExp(`(${NUM})\\s*โมง(?:\\s*ครึ่ง)?(?!\\s*(?:เช้า|เย็น))`, 'g'),
    at: (m) => { const h = toNumber(m[1]); if (h == null) return null;
      return hhmm(h, /ครึ่ง/.test(m[0]) ? 30 : 0); } },

  // already numeric — "13:30", "13.30 น.", "13 น."
  { re: /(\d{1,2})[:.](\d{2})\s*(?:น\.?)?/g,
    at: (m) => { const h = Number(m[1]); const mi = Number(m[2]);
      return h < 24 && mi < 60 ? hhmm(h, mi) : null; } },
  { re: /(?<![:.\d])(\d{1,2})\s*นาฬิกา|(?<![:.\d])(\d{1,2})\s*น\.(?!\d)/g,
    at: (m) => { const h = Number(m[1] ?? m[2]); return h < 24 ? hhmm(h) : null; } },
];

/**
 * Every time expression in a sentence, in the order they appear.
 * @returns {{text:string, time:string, index:number}[]}
 */
export function extractTimes(text) {
  if (!text) return [];
  const found = [];
  const taken = [];
  const overlaps = (s, e) => taken.some(([a, b]) => s < b && e > a);

  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(text)) !== null) {
      const start = m.index;
      const end = m.index + m[0].length;
      if (overlaps(start, end)) continue;
      const time = rule.at(m);
      // Claim the span either way: a rule that deliberately returns null (เที่ยงธรรม) is saying
      // "this is not a time", and a later rule must not get a second look at the same characters.
      taken.push([start, end]);
      if (!time) continue;
      found.push({ text: m[0].trim(), time, index: start });
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

/** The first time expression in a sentence, or null. */
export function parseThaiTime(text) {
  return extractTimes(text)[0]?.time ?? null;
}

/** Rewrite every spoken time in a sentence to HH:MM, leaving the rest untouched. */
export function normaliseTimes(text) {
  const times = extractTimes(text);
  if (!times.length) return text;
  let out = '';
  let cursor = 0;
  for (const t of times) {
    out += text.slice(cursor, t.index) + t.time;
    cursor = t.index + t.text.length;
  }
  return out + text.slice(cursor);
}

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const isHHMM = (v) => typeof v === 'string' && HHMM_RE.test(v);

/**
 * Check the times a model produced against the sentence it was given.
 *
 * A model that returns a malformed time, or one that contradicts an unambiguous spoken expression,
 * is corrected from the source text rather than trusted — the point of this file.
 *
 * @returns {{items:Array, corrections:Array}}
 */
export function reconcile(items, sourceText) {
  const spoken = extractTimes(sourceText ?? '');
  const corrections = [];

  const fixed = items.map((item, i) => {
    const out = { ...item };

    if (!isHHMM(out.time)) {
      const recovered = spoken[i]?.time ?? parseThaiTime(out.raw_time ?? out.title ?? '');
      if (recovered) {
        corrections.push({ index: i, from: out.time ?? null, to: recovered, reason: 'รูปแบบเวลาไม่ถูกต้อง' });
        out.time = recovered;
      } else {
        out.time = null;
      }
      return out;
    }

    // The model returned a valid time; make sure it agrees with what was actually said.
    const said = spoken.find((s) => {
      const own = parseThaiTime(s.text);
      return own != null && (out.raw_time ? s.text.includes(out.raw_time) : false);
    });
    if (said && said.time !== out.time) {
      corrections.push({ index: i, from: out.time, to: said.time, reason: `"${said.text}" ตรงกับ ${said.time}` });
      out.time = said.time;
    }
    return out;
  });

  return { items: fixed, corrections };
}

/** Chronological order, with untimed entries last — the order a caregiver reads a day in. */
export function sortByTime(items) {
  return [...items].sort((a, b) => {
    if (!a.time && !b.time) return 0;
    if (!a.time) return 1;
    if (!b.time) return -1;
    return a.time.localeCompare(b.time);
  });
}
