// Windows-1252 encode/decode (ProvideX programs use the ANSI code page).
const HIGH = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008DŽ\u008F\u0090‘’“”•–—˜™š›œ\u009DžŸ';
const REV = new Map<number, number>();
for (let i = 0; i < 32; i++) REV.set(HIGH.charCodeAt(i), 0x80 + i);

export function encode1252(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80 || (c >= 0xa0 && c <= 0xff)) out[i] = c;
    else out[i] = REV.get(c) ?? 0x3f; // '?'
  }
  return out;
}

export function decode1252(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    s += c >= 0x80 && c < 0xa0 ? HIGH[c - 0x80] : String.fromCharCode(c);
  }
  return s;
}
