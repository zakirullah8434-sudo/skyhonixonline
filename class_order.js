/**
 * Natural class ordering shared by the backend.
 * Order: Early years (Play Group → Reception → Pre-Nursery → Nursery → Prep)
 *        → KG family (KG → LKG/KG1 → UKG/KG2)
 *        → numbered grades (1st, 2nd, 3rd, ... Class 10)
 *        → everything else (alphabetical).
 */

const WORD_NUMBERS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7,
  eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12
};

const EARLY_TOKENS = new Set(['play', 'group', 'reception', 'pre', 'nursery', 'prep', 'pg']);

function normalizeTokens(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function extractGrade(tokens) {
  for (const t of tokens) {
    if (WORD_NUMBERS[t] !== undefined) return WORD_NUMBERS[t];
    const m = t.match(/^(\d{1,2})(st|nd|rd|th)?$/);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

/**
 * Returns a sortable tuple [group, rank, text] for a class name.
 */
function classSortTuple(name) {
  const raw = String(name || '').trim();
  const tokens = normalizeTokens(raw);
  const joined = tokens.join(' ');
  if (!joined) return [99, 0, ''];

  const hasDigit = /\d/.test(joined);

  // Group 0: early years (only when no grade digit is present, so "Prep 1" stays grade 1)
  if (!hasDigit && tokens.some(t => EARLY_TOKENS.has(t))) {
    let sub = 5;
    if (tokens.includes('play') || tokens.includes('pg')) sub = 0;
    else if (tokens.includes('reception')) sub = 1;
    else if (tokens.includes('pre')) sub = 2;      // Pre-Nursery / Pre-KG
    else if (tokens.includes('nursery')) sub = 3;
    else if (tokens.includes('prep')) sub = 4;
    return [0, sub, joined];
  }

  // Group 0.5 (integer 1 slot): KG family — UKG/KG2 > LKG/KG1 > KG
  if (tokens.some(t => /^(kg|kinder|ukg|lkg)$/.test(t) || /^kg[12]$/.test(t))) {
    let sub = 0; // plain KG / Kindergarten
    if (tokens.includes('ukg') || tokens.includes('kg2')) sub = 2;
    else if (tokens.includes('lkg') || tokens.includes('kg1')) sub = 1;
    return [1, sub, joined];
  }

  // Group 2: numbered grades (1st, 2nd, Class 5, Grade 10, ...)
  const grade = extractGrade(tokens);
  if (grade !== null) {
    return [2, grade, joined];
  }

  // Group 3: everything else (Matric, FSc, FA, custom names) — alphabetical
  return [3, 0, joined];
}

function compareClasses(a, b) {
  const ta = classSortTuple(a);
  const tb = classSortTuple(b);
  if (ta[0] !== tb[0]) return ta[0] - tb[0];
  if (ta[1] !== tb[1]) return ta[1] - tb[1];
  return String(ta[2]).localeCompare(String(tb[2]));
}

function sortClassNames(names) {
  return (names || []).slice().sort(compareClasses);
}

function compareStudents(a, b) {
  const c = compareClasses(a.class_name, b.class_name);
  if (c !== 0) return c;
  const ra = parseInt(a.roll_no, 10);
  const rb = parseInt(b.roll_no, 10);
  const aNum = !isNaN(ra);
  const bNum = !isNaN(rb);
  if (aNum && bNum && ra !== rb) return ra - rb;
  if (aNum !== bNum) return aNum ? -1 : 1;
  const rollC = String(a.roll_no || '').localeCompare(String(b.roll_no || ''), undefined, { numeric: true });
  if (rollC !== 0) return rollC;
  return String(a.name || '').localeCompare(String(b.name || ''));
}

module.exports = { classSortTuple, compareClasses, sortClassNames, compareStudents };
