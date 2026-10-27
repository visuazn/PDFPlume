// Helpers shared by the workspace widgets.

export const FILE_COLORS = ['#5b5bd6', '#2a9d61', '#c97a00', '#d6409f', '#0a8fb3', '#8e4ec6', '#e5484d', '#5b6577'];

/** [0,1,2,4] -> "1-3,5" */
export function rangeString(indexes) {
  const s = [...new Set(indexes)].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < s.length; i++) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    out.push(j > i ? `${s[i] + 1}-${s[j] + 1}` : `${s[i] + 1}`);
    i = j;
  }
  return out.join(',');
}

/** "1-3,5" -> Set{0,1,2,4}; ignores invalid parts. */
export function parsePages(text, count) {
  const set = new Set();
  for (const part of String(text || '').split(/[,;\s]+/)) {
    if (!part) continue;
    const m = part.match(/^(\d*)\s*-\s*(\d*)$/);
    let a; let b;
    if (m) { a = m[1] ? +m[1] : 1; b = m[2] ? +m[2] : count; } else if (/^\d+$/.test(part)) { a = b = +part; } else continue;
    if (a > b) [a, b] = [b, a];
    for (let p = Math.max(1, a); p <= Math.min(count, b); p++) set.add(p - 1);
  }
  return set;
}

export function rotatedImgStyle(rotation) {
  const r = ((rotation % 360) + 360) % 360;
  return `transform: rotate(${r}deg)${r % 180 ? ' scale(.72)' : ''}`;
}
