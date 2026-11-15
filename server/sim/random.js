// Seeded random numbers (mulberry32), so the synthetic city is the same on every laptop.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const makeRand = seed => { const r = mulberry32(seed); const f = (a, b) => a + (b - a) * r(); f.raw = r; return f; };
module.exports = { mulberry32, makeRand };
