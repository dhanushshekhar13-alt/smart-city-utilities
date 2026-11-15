// City time helpers. Every business timestamp is "city time" (the simulated clock), always shown in IST.
const HOUR = 3600e3;
const TICK_MIN = 15;
const TICK = TICK_MIN * 60e3;
const IST_OFFSET = 5.5 * HOUR;
const SIM_START = Date.parse('2026-10-25T08:00:00+05:30');

const cityDate = t => new Date(t + IST_OFFSET).toISOString().slice(0, 10);            // 'YYYY-MM-DD' in IST
const istHour = t => new Date(t + IST_OFFSET).getUTCHours();
const startOfIstDay = date => Date.parse(`${date}T00:00:00+05:30`);
// first instant of the month after the given IST date
function nextMonthStart(date) {
  let [y, m] = date.split('-').map(Number);
  m += 1; if (m > 12) { m = 1; y += 1; }
  return Date.parse(`${y}-${String(m).padStart(2, '0')}-01T00:00:00+05:30`);
}
module.exports = { HOUR, TICK, TICK_MIN, IST_OFFSET, SIM_START, cityDate, istHour, startOfIstDay, nextMonthStart };
