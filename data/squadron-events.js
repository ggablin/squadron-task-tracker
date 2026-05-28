// Squadron-wide UTA timeline events.
// Source: 108th CES June 2026 newsletter timeline.
// Used by seed.js (full re-seed) and server.js (empty-table bootstrap).
module.exports = [
  // Friday 5 June
  { day:'Friday',   start_time:'0700', end_time:'0800', title:"Supervisor's Meeting",          details:'Safety briefing / TBA training',  kind:'meeting',   is_concurrent:false, emphasis:null,                                  attendees:null, sort_order:1 },
  { day:'Friday',   start_time:'0800', end_time:'0830', title:'Formation / Roll Call',          details:'Everyone report',                 kind:'formation', is_concurrent:false, emphasis:null,                                  attendees:null, sort_order:2 },
  { day:'Friday',   start_time:'0830', end_time:'1100', title:'Admin / In-House Training',      details:'Medical/CBTs/vRED/SGLI/EPBs/UGT/Work Orders/JSTO/Form 55s/PT Testing/DTS/AROWS', kind:'training', is_concurrent:false, emphasis:'FOCUS ON LOTO & FALL PROTECTION', attendees:null, sort_order:3 },
  { day:'Friday',   start_time:'1100', end_time:'1300', title:'Lunch',                          details:null,                              kind:'lunch',     is_concurrent:false, emphasis:null,                                  attendees:null, sort_order:4 },
  { day:'Friday',   start_time:'1300', end_time:'1500', title:'Admin / In-House Training',      details:'Medical/CBTs/vRED/SGLI/EPBs/UGT/Work Orders/JSTO/Form 55s/PT Testing/DTS/AROWS', kind:'training', is_concurrent:false, emphasis:'FOCUS ON LOTO & FALL PROTECTION', attendees:null, sort_order:5 },
  { day:'Friday',   start_time:'1500', end_time:null,   title:'MSgt Fernandez Retirement Ceremony', details:'247 Mount Misery Road, Browns Mills NJ 08015 — Ceremony begins at 1500hrs', kind:'briefing', is_concurrent:false, emphasis:null, attendees:null, sort_order:6 },

  // Saturday 6 June
  { day:'Saturday', start_time:'0800', end_time:'0830', title:'Formation / Roll Call',          details:'Everyone report',                 kind:'formation', is_concurrent:false, emphasis:null,                                  attendees:null, sort_order:1 },
  { day:'Saturday', start_time:'0830', end_time:'1130', title:'CPR Training',                   details:'w/ Capt Monico',                  kind:'training',  is_concurrent:false, emphasis:null, attendees:[
    { shop:'Banks' },
    { shop:'Cabbler' },
    { shop:'Charles' },
    { shop:'Glenn' },
    { shop:'Grossmick' },
    { shop:'Hankinson' },
    { shop:'Jenkins' },
    { shop:'McCullough' },
  ], sort_order:2 },
  { day:'Saturday', start_time:'0830', end_time:'1100', title:'Admin / In-House Training',      details:'Medical/CBTs/vRED/SGLI/EPBs/UGT/Work Orders/JSTO/Form 55s/PT Testing/DTS/AROWS', kind:'training', is_concurrent:true, emphasis:null, attendees:null, sort_order:3 },
  { day:'Saturday', start_time:'1100', end_time:'1300', title:'Lunch',                          details:null,                              kind:'lunch',     is_concurrent:false, emphasis:null,                                  attendees:null, sort_order:4 },
  { day:'Saturday', start_time:'1300', end_time:null,   title:'Change into AF PT Gear',         details:'Rally on back pad',               kind:'formation', is_concurrent:false, emphasis:null,                                  attendees:null, sort_order:5 },
  { day:'Saturday', start_time:'1300', end_time:'1600', title:'5K CE Formation For The Fallen', details:'Morale event',                    kind:'training',  is_concurrent:true,  emphasis:null,                                  attendees:null, sort_order:6 },
  { day:'Saturday', start_time:'1600', end_time:null,   title:'Morale BBQ',                     details:null,                              kind:'lunch',     is_concurrent:false, emphasis:null,                                  attendees:null, sort_order:7 },

  // Sunday 7 June
  { day:'Sunday',   start_time:'0800', end_time:'0830', title:'Formation / Roll Call',          details:'Everyone report',                 kind:'formation', is_concurrent:false, emphasis:null,                                  attendees:null, sort_order:1 },
  { day:'Sunday',   start_time:'0830', end_time:'1100', title:'Admin / In-House Training',      details:'Medical/CBTs/vRED/SGLI/EPBs/UGT/Work Orders/JSTO/Form 55s/PT Testing/DTS/AROWS', kind:'training', is_concurrent:false, emphasis:null, attendees:null, sort_order:2 },
  { day:'Sunday',   start_time:'0830', end_time:'1100', title:'SAPR Training',                  details:'w/ Ms. Cuje in the Classroom',    kind:'training',  is_concurrent:true,  emphasis:null,                                  attendees:null, sort_order:3 },
  { day:'Sunday',   start_time:'0830', end_time:'1100', title:'Supervisors: Finish Safety Binders', details:'Turn in to SSgt Huertas',     kind:'admin',     is_concurrent:true,  emphasis:null,                                  attendees:null, sort_order:4 },
  { day:'Sunday',   start_time:'1100', end_time:'1300', title:'Lunch',                          details:null,                              kind:'lunch',     is_concurrent:false, emphasis:null,                                  attendees:null, sort_order:5 },
  { day:'Sunday',   start_time:'1300', end_time:null,   title:'Final DFT Meeting',              details:'DFT folks',                       kind:'meeting',   is_concurrent:false, emphasis:null,                                  attendees:null, sort_order:6 },
  { day:'Sunday',   start_time:'1300', end_time:'1400', title:'Building Cleanup',               details:null,                              kind:'work',      is_concurrent:true,  emphasis:null,                                  attendees:null, sort_order:7 },
  { day:'Sunday',   start_time:'1300', end_time:null,   title:'How Goes It Meeting',            details:'Leadership',                      kind:'meeting',   is_concurrent:true,  emphasis:null,                                  attendees:null, sort_order:8 },
  { day:'Sunday',   start_time:'1500', end_time:null,   title:'Formation',                      details:'End of UTA',                      kind:'formation', is_concurrent:false, emphasis:null,                                  attendees:null, sort_order:9 },
];
