// Squadron-wide UTA timeline events.
// Source: 108th CES May 2026 newsletter timeline.
// Used by seed.js (full re-seed) and server.js (empty-table bootstrap).
module.exports = [
  // Friday
  { day:'Friday',   start_time:'0700', end_time:'0800', title:"Supervisor's Meeting",          details:'Safety briefing · TBA training', kind:'meeting',   is_concurrent:false, emphasis:null,                                  attendees:null, sort_order:1 },
  { day:'Friday',   start_time:'0800', end_time:'0830', title:'Formation · Roll Call',          details:'Everyone report',                kind:'formation', is_concurrent:false, emphasis:null,                                  attendees:null, sort_order:2 },
  { day:'Friday',   start_time:'0830', end_time:'1100', title:'Admin / In-House Training',      details:'Medical · CBTs · vRED · SGLI · EPBs · UGT · Work Orders · JSTO · Form 55s · PT Testing', kind:'training', is_concurrent:false, emphasis:'Focus on LOTO & Fall Protection', attendees:null, sort_order:3 },
  { day:'Friday',   start_time:'1100', end_time:'1300', title:'Lunch · 1100–1300',              details:null,                              kind:'lunch',     is_concurrent:false, emphasis:null,                                  attendees:null, sort_order:4 },
  { day:'Friday',   start_time:'1300', end_time:'1500', title:'Work Orders · Shop Training · Admin', details:'All things work order related · Shop training · Admin items · SrA EPBs', kind:'work', is_concurrent:false, emphasis:null, attendees:null, sort_order:5 },
  { day:'Friday',   start_time:'1500', end_time:'1600', title:'Formation',                      details:'End of day',                      kind:'formation', is_concurrent:false, emphasis:null,                                  attendees:null, sort_order:6 },

  // Saturday
  { day:'Saturday', start_time:'0800', end_time:'0830', title:'Formation · Roll Call',          details:'Everyone report',                kind:'formation', is_concurrent:false, emphasis:null,                                  attendees:null, sort_order:1 },
  { day:'Saturday', start_time:'0830', end_time:'1000', title:'Lautenberg & Family Care Plans', details:'with MSgt Burton',                kind:'briefing',  is_concurrent:false, emphasis:null,                                  attendees:null, sort_order:2 },
  { day:'Saturday', start_time:'0830', end_time:'1100', title:'Admin / In-House Training',      details:'Medical · CBTs · vRED · SGLI · EPBs · UGT · Form 55s · PT Testing', kind:'training', is_concurrent:true, emphasis:null, attendees:null, sort_order:3 },
  { day:'Saturday', start_time:'1000', end_time:'1100', title:'Health Risk Assessment',         details:'Pow Pro & HVAC · w/ MSgt Golden', kind:'medical',   is_concurrent:false, emphasis:null,                                  attendees:null, sort_order:4 },
  { day:'Saturday', start_time:'1100', end_time:'1300', title:'Lunch · 1100–1300',              details:null,                              kind:'lunch',     is_concurrent:false, emphasis:null,                                  attendees:null, sort_order:5 },
  { day:'Saturday', start_time:'1300', end_time:'1400', title:'Health Risk Assessment',         details:'Electrical & Structures · w/ MSgt Golden', kind:'medical', is_concurrent:false, emphasis:null,                       attendees:null, sort_order:6 },
  { day:'Saturday', start_time:'1300', end_time:null,   title:'Morale Committee Meeting',       details:'Conference Room',                 kind:'meeting',   is_concurrent:true,  emphasis:null,                                  attendees:null, sort_order:7 },
  { day:'Saturday', start_time:'1400', end_time:'1500', title:'Health Risk Assessment',         details:'WFSM & Heavy · w/ MSgt Golden',   kind:'medical',   is_concurrent:false, emphasis:null,                                  attendees:null, sort_order:8 },
  { day:'Saturday', start_time:'1400', end_time:'1600', title:'Work Orders · Shop Training · Admin', details:'All things work order related · Shop training · Admin items · SrA EPBs', kind:'work', is_concurrent:true, emphasis:null, attendees:null, sort_order:9 },
  { day:'Saturday', start_time:'1500', end_time:'1600', title:'Health Risk Assessment',         details:'EA · w/ MSgt Golden',             kind:'medical',   is_concurrent:false, emphasis:null,                                  attendees:null, sort_order:10 },
  { day:'Saturday', start_time:'1600', end_time:null,   title:'Formation',                      details:'End of day',                      kind:'formation', is_concurrent:false, emphasis:null,                                  attendees:null, sort_order:11 },

  // Sunday
  { day:'Sunday',   start_time:'0800', end_time:'0830', title:'Formation · Roll Call',          details:'Everyone report',                kind:'formation', is_concurrent:false, emphasis:null,                                  attendees:null, sort_order:1 },
  { day:'Sunday',   start_time:'0830', end_time:'1100', title:'CPR Training',                   details:'Classroom · w/ Capt Monico',      kind:'training',  is_concurrent:false, emphasis:null, attendees:[
    { rank:'TSgt', last:'Banks' },
    { rank:'SSgt', last:'Cabbler' },
    { rank:'SSgt', last:'Charles' },
    { rank:'A1C',  last:'Glenn' },
    { rank:'TSgt', last:'Grossmick' },
    { rank:'SSgt', last:'Hankinson' },
    { rank:'SrA',  last:'Jenkins' },
    { rank:'A1C',  last:'Whittingham' },
  ], sort_order:2 },
  { day:'Sunday',   start_time:'0830', end_time:'1100', title:'Supervisors: Finish Safety Binders', details:'Turn in to SSgt Huertas',     kind:'admin',     is_concurrent:true,  emphasis:null,                                  attendees:null, sort_order:3 },
  { day:'Sunday',   start_time:'0830', end_time:'1100', title:'Admin / In-House Training',      details:'For everyone else',               kind:'training',  is_concurrent:true,  emphasis:null,                                  attendees:null, sort_order:4 },
  { day:'Sunday',   start_time:'1100', end_time:'1300', title:'Lunch · 1100–1300',              details:null,                              kind:'lunch',     is_concurrent:false, emphasis:null,                                  attendees:null, sort_order:5 },
  { day:'Sunday',   start_time:'1300', end_time:'1400', title:'Building Cleanup',               details:'All hands',                       kind:'work',      is_concurrent:false, emphasis:null,                                  attendees:null, sort_order:6 },
  { day:'Sunday',   start_time:'1300', end_time:null,   title:'How Goes It Meeting',            details:'Leadership',                      kind:'meeting',   is_concurrent:true,  emphasis:null,                                  attendees:null, sort_order:7 },
  { day:'Sunday',   start_time:'1400', end_time:'1500', title:'CE Recognition · Recap of UTA',  details:'Squadron-wide',                   kind:'briefing',  is_concurrent:false, emphasis:null,                                  attendees:null, sort_order:8 },
  { day:'Sunday',   start_time:'1500', end_time:null,   title:'Formation',                      details:'End of UTA',                      kind:'formation', is_concurrent:false, emphasis:null,                                  attendees:null, sort_order:9 },
];
