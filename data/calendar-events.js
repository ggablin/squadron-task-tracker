// Squadron calendar events — TDY and training rotations. Transcribed from the
// newsletter's MEETs / RADR / Silver Flag slide (newsletter/static/meets-radr.html),
// which stays hand-edited for now: this table feeds the app's Calendar tab only.
// Loaded into calendar_events the first time the boot migration creates that
// table (lib/calendar-events.js).
//
// The title carries the kind — the squadron writes RADR, Silver Flag, REOTS —
// and attendees are free text for the same reason duty owners are: the roster
// includes ranks, initials and "(possibly)".
module.exports = [
  { title: 'HIGH POWER GEN', location: 'New London, NC', start: '2025-12-07', end: '2025-12-12',
    attendees: 'A1C Veal / A1C Whittingham', status: 'complete', note: null },
  { title: 'RADR', location: 'New London, NC', start: '2026-01-11', end: '2026-01-17',
    attendees: 'SrA Hill', status: 'complete', note: null },
  { title: 'Silver Flag', location: 'Tyndall AFB, FL', start: '2026-01-11', end: '2026-01-17',
    attendees: 'TSgt Grossmick / TSgt Price / TSgt Ebbert', status: 'complete', note: null },
  { title: 'RADR', location: 'Tyndall AFB, FL', start: '2026-01-25', end: '2026-01-31',
    attendees: 'SSgt Uzoma / SSgt Huertas / SrA Torres / SrA Mattson', status: 'cancelled', note: null },
  { title: 'REOTS', location: 'FIG, PA', start: '2026-02-01', end: '2026-02-07',
    attendees: 'A1C Padilla', status: 'complete', note: null },
  { title: 'RADR', location: 'Dobbins ARB, GA', start: '2026-04-12', end: '2026-04-18',
    attendees: 'SrA Fowler', status: 'complete', note: null },
  { title: 'RADR', location: 'Fargo, ND', start: '2026-05-03', end: '2026-05-09',
    attendees: 'MSgt Brown', status: 'scheduled', note: null },
  { title: 'RADR', location: 'Tyndall AFB, FL', start: '2026-05-17', end: '2026-05-23',
    attendees: 'MSgt Fernandez G.', status: 'scheduled', note: null },
  { title: 'RADR', location: 'Ft Smith ARB, AR', start: '2026-06-07', end: '2026-06-13',
    attendees: 'A1C Whittingham', status: 'scheduled', note: null },
  { title: 'FY26 DFT', location: 'Camp Murray, WA', start: '2026-06-15', end: '2026-06-29',
    attendees: 'Lt Col Gorey, Maj Ye, Lt Select Maramba, Lt Select Banks, CMSgt Romer, SMSgt King, '
      + 'SMSgt Gablin, MSgt McNaughton, MSgt Fernandez G., MSgt Sousa, MSgt McCullough, '
      + 'MSgt White (possibly), MSgt Beljour-Sommer, MSgt Tarasewicz, TSgt Beltran, SSgt Uzoma, '
      + 'SSgt Hankinson, SrA Palomino, SrA Hill, SrA Torres, SrA Fowler, A1C Glenn, A1C Whittingham',
    status: 'scheduled', note: null },
];
