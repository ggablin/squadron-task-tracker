// newsletter/theme.js — the newsletter's visual layer, in the app's design language.
//
// Replaces the previous navy/serif "PowerPoint" look. Every token here is copied
// from public/design.css so the printed newsletter and the web app read as one
// product: same card treatment, same urgency colours, same typeface. One deliberate
// departure (Sep 2026): the PAGE is white and the BOXES are cream, the reverse of
// the app. This deck gets photocopied — a cream page is a grey page on paper and a
// toner bill on 70 copies — so white carries the page and cream marks the boxes. General Sans is inlined as base64 so the HTML is a single portable
// file — a newsletter that only looks right on a machine with the fonts
// installed is not much use for something emailed to 70 people.

const fs = require('fs');
const path = require('path');

const FONT_DIR = path.join(__dirname, '..', 'public', 'fonts');

function fontFace(weight) {
  const file = path.join(FONT_DIR, `general-sans-${weight}.woff2`);
  try {
    const b64 = fs.readFileSync(file).toString('base64');
    return `@font-face{font-family:'General Sans';font-style:normal;font-weight:${weight};
      font-display:swap;src:url(data:font/woff2;base64,${b64}) format('woff2');}`;
  } catch {
    return ''; // falls back to the system stack below
  }
}

const FONTS = [400, 500, 600, 700].map(fontFace).join('\n');

const STYLES = `
${FONTS}

/* ── Tokens: verbatim from public/design.css ─────────────────────────────── */
:root{
  --cream:#f6f7ed; --bg:#fdfdfa; --s2:#f5f5ef;
  --border:#f1f1ea; --bm:#e8e9e0;
  --text:#1f1f1f; --t2:#6f7066; --t3:#b8b9b0; --t3-nav:#696660;
  --urgent:#a8472f; --urg-bg:#f5ece9;
  --warn:#7d5f2a;   --wrn-bg:#f5eedf;
  --ok:#55704f;     --ok-bg:#edf2eb;
  --info:#2f5c8a;   --info-bg:#e9f0f7; --info-bd:#c2d6e8;
  --hair:#dfe0d6;   /* a rule that still shows on a cream box, on paper */
  --r:14px; --rs:10px;
}

/* Without this Chrome's default print settings drop every background, and the
   cream boxes, colour bars and shop tints this deck is organised by vanish. */
*{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
html,body{margin:0;padding:0;}
body{
  background:var(--bm);
  font-family:'General Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  color:var(--text);
  -webkit-font-smoothing:antialiased;
}

/* ── Screen-only toolbar ─────────────────────────────────────────────────── */
.toolbar{
  position:sticky;top:0;z-index:20;background:var(--text);color:var(--cream);
  padding:11px 20px;display:flex;gap:16px;align-items:center;font-size:13px;
}
.toolbar button{
  background:var(--cream);color:var(--text);border:0;padding:7px 16px;
  font-weight:600;border-radius:999px;cursor:pointer;font-size:13px;font-family:inherit;
}
.toolbar .hint{opacity:.7;font-size:12px;}
/* The newsletter opens in a new tab from the tracker. In an installed PWA there
   is no browser chrome to go back with, so it needs its own way home.
   A <button> rather than an <a href>: this deck gets emailed and saved as a PDF,
   and test/newsletter-http.test.js enforces that the page carries no src/href
   outside data: URIs so it survives that. A relative link would point nowhere in
   an emailed copy anyway. It sits in .no-print, like the print button, so it
   never reaches the PDF. */
.toolbar button.back{
  background:var(--cream);color:var(--text);font-weight:700;
  border:0;padding:8px 16px;white-space:nowrap;
}
.toolbar button.back:hover{opacity:.9;}

.deck{display:flex;flex-direction:column;align-items:center;gap:20px;padding:20px;}

/* ── Slide = one landscape page ──────────────────────────────────────────── */
.slide{
  background:#fff;
  width:11in;height:8.5in;
  padding:.46in .55in .4in;
  position:relative;display:flex;flex-direction:column;overflow:hidden;
  box-shadow:0 2px 16px rgba(0,0,0,.22);
}

/* Header: the app's eyebrow + title, left-aligned. No centred serif, no rule —
   the app never underlines a heading. */
.slide-hd{display:flex;align-items:baseline;justify-content:space-between;gap:20px;margin-bottom:14px;}
.slide-eyebrow{
  font-size:9.5px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;
  color:var(--t2);margin-bottom:5px;
}
.slide-title{font-size:27px;font-weight:700;line-height:1.1;margin:0;color:var(--text);}
.slide-hd-right{font-size:10.5px;color:var(--t2);font-weight:500;white-space:nowrap;text-align:right;}
.slide-body{flex:1;font-size:12px;line-height:1.45;min-height:0;overflow:hidden;}
/* A sparse slide sets type larger rather than leaving half a page white. */
.roomy .slide-body{font-size:14px;}
.two-col > .card{flex:1;margin:0;}
.roomy .notice-t{font-size:17px;}
.roomy .step .t{font-size:14px;}
.roomy .step .s{font-size:12px;}
.roomy .intro{font-size:13px;max-width:none;}
.roomy .card-hd{font-size:10.5px;}
.roomy .note{font-size:12px;}
.slide-ft{
  margin-top:auto;padding-top:9px;display:flex;justify-content:space-between;
  font-size:9.5px;color:var(--t3-nav);border-top:1.5px solid var(--bm);
}

/* ── Card: the single repeated motif, straight from the app ──────────────── */
.card{background:var(--cream);border:1.5px solid var(--bm);border-radius:var(--r);padding:12px 14px;}
.card + .card{margin-top:10px;}
.card.accent-urgent{background:var(--urg-bg);border-color:#e3c9bf;}
.card.accent-urgent .card-hd{color:var(--urgent);}
.card.accent-info{background:var(--info-bg);border-color:var(--info-bd);}
.card.accent-info .card-hd{color:var(--info);}
.card.accent-warn{background:var(--wrn-bg);border-color:#e3d3ae;}
.card.accent-warn .card-hd{color:var(--warn);}
.card.accent-ok{background:var(--ok-bg);border-color:#cfdccb;}
.card.accent-ok .card-hd{color:var(--ok);}
/* A squadron-wide notice: one cream strip with an ink edge, not a 73-row table. */
.card.notice{border-left:5px solid var(--text);display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;}
.notice-t{font-size:13px;font-weight:700;}
.notice-n{font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--t2);}
.notice .note{margin:0;flex-basis:100%;}
/* The sentence a whole card shares, printed once under its heading. */
.note{font-size:10.5px;color:var(--t2);margin:-2px 0 8px;line-height:1.45;}
.card > .note:last-child{margin-bottom:0;}
.card-hd{
  font-size:9.5px;font-weight:700;letter-spacing:.13em;text-transform:uppercase;
  color:var(--t2);margin-bottom:8px;display:flex;justify-content:space-between;align-items:baseline;
}
.card-hd .count{letter-spacing:0;text-transform:none;font-weight:600;color:var(--t3-nav);}

h3{font-size:13px;font-weight:700;margin:0 0 7px;color:var(--text);}
.intro{font-size:11.5px;color:var(--t2);margin:0 0 12px;line-height:1.5;max-width:9in;}
.muted{color:var(--t2);} .b{font-weight:600;}

/* ── Urgency badges — same shapes and pairings as the task list ──────────── */
.badge{
  display:inline-block;font-size:9px;font-weight:600;padding:2px 8px;border-radius:999px;
  white-space:nowrap;letter-spacing:.01em;
}
.b-overdue{background:var(--urg-bg);color:var(--urgent);}
.b-this{background:var(--wrn-bg);color:var(--warn);}
.b-next{background:var(--ok-bg);color:var(--ok);}
.b-info{background:var(--info-bg);color:var(--info);}
.overdue{color:var(--urgent);font-weight:600;}
.due-month{color:var(--warn);font-weight:600;}
.complete{color:var(--ok);font-weight:600;}
.red{color:var(--urgent);}

/* ── Person rows ─────────────────────────────────────────────────────────── */
.p-row{display:flex;align-items:baseline;gap:7px;padding:3.5px 0;border-bottom:1px solid var(--hair);}
.p-row:last-child{border-bottom:0;}
.p-name{font-weight:600;font-size:11.5px;}
.p-note{color:var(--t2);font-size:10.5px;overflow-wrap:anywhere;}
.p-spacer{flex:1;}

/* ── Cover ───────────────────────────────────────────────────────────────── */
.cover{background:#fff;color:var(--text);justify-content:center;padding:.9in 1in;position:relative;
  border-top:.22in solid var(--text);}
.cover-eyebrow{font-size:12px;font-weight:700;letter-spacing:.22em;color:var(--t2);text-transform:uppercase;}
.cover-title{font-size:82px;font-weight:700;line-height:1;margin:16px 0 0;letter-spacing:-.015em;}
.cover-sub{font-size:20px;color:var(--t2);margin-top:18px;font-weight:500;}
.cover-meta{
  position:absolute;left:1in;right:1in;bottom:.85in;
  display:flex;justify-content:space-between;align-items:flex-end;
  font-size:11px;color:var(--t2);
}
.cover-url{font-size:15px;font-weight:600;color:var(--text);}
.cover-stats{display:flex;gap:14px;margin-top:40px;}
.cover-stat{background:var(--cream);border:1.5px solid var(--bm);border-radius:var(--r);padding:16px 26px 14px;min-width:150px;}
.cover-stat .n{font-size:34px;font-weight:700;line-height:1;}
.cover-stat .l{font-size:10.5px;color:var(--t2);margin-top:6px;letter-spacing:.05em;text-transform:uppercase;}

/* ── Org chart ───────────────────────────────────────────────────────────
   A real chart, connectors in CSS so no script is needed to print it.
   Vertical rhythm: staff row → 14px stub → rung → 14px → rung → 14px → rung
   → 16px bar → NCOIC → 12px → member grid. The lines are borders and
   pseudo-elements; boxes have opaque backgrounds so a rule can run behind a
   row and show only in the gaps. */
.org .slide-body{display:flex;flex-direction:column;justify-content:center;}
.org-chart{display:flex;flex-direction:column;align-items:stretch;}
.org-box{
  border:1.5px solid var(--bm);border-radius:var(--rs);padding:9px 14px;text-align:center;
  min-width:150px;background:var(--cream);position:relative;z-index:1;
}
.org-pos{font-size:8.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--t2);}
.org-name{font-size:14px;font-weight:600;margin-top:2px;}
.b-cmd,.b-oic{background:var(--text);color:var(--cream);border-color:var(--text);}
.b-cmd .org-pos,.b-oic .org-pos,.b-chief .org-pos,.b-1sg .org-pos,.b-supt .org-pos{color:rgba(246,247,237,.72);}
.b-chief{background:#3d4036;color:var(--cream);border-color:#3d4036;}
.b-1sg{background:var(--urgent);color:#fff;border-color:var(--urgent);}
.b-1sg .org-pos{color:rgba(255,255,255,.8);}
.b-admin{background:var(--cream);}
.b-supt{background:var(--text);color:var(--cream);border-color:var(--text);}
.b-ncoic{background:#fff;border-color:var(--t3);}
.b-peer{background:var(--wrn-bg);border-color:#d9c9a3;}
/* An open billet: same footprint, dashed, quiet. */
.b-vacant,.b-vacant.b-oic,.b-vacant.b-supt,.b-vacant.b-ncoic{
  background:var(--s2);color:var(--t2);border:1.5px dashed var(--t3);}
.b-vacant .org-pos{color:var(--t2);}
.b-vacant .org-name{font-style:italic;font-weight:500;}

/* Staff row: five equal columns, Commander in column 3 so the spine is centred.
   The rule runs from the CEM's centre (col 2 → 30%) to Admin's (col 5 → 90%). */
.org-top{display:grid;grid-template-columns:repeat(5,1fr);position:relative;}
.org-top .org-box{justify-self:center;min-width:0;width:88%;}
.org-top::before{content:'';position:absolute;left:30%;right:10%;top:50%;border-top:2.5px solid var(--t3);}

/* The spine: each rung hangs from the one above on a 14px stub. */
.org-spine{display:flex;flex-direction:column;align-items:center;}
.org-rung{position:relative;padding-top:20px;}
.org-rung::before{content:'';position:absolute;top:0;left:50%;width:2.5px;height:20px;margin-left:-1px;background:var(--t3);}
.org-rung .org-box{width:270px;}
.org-rung-last::after{content:'';position:absolute;left:50%;bottom:-22px;width:2.5px;height:22px;margin-left:-1px;background:var(--t3);}

/* Fan-out: a bar across the top of the branches, a stub down into each. Branches
   sit flush (padding, no gap) so the bar is continuous; the first and last child
   start and stop at their own centres, and an only child draws no bar at all. */
.org-branches{display:flex;justify-content:center;align-items:flex-start;position:relative;padding-top:22px;}
.org-branch{position:relative;padding:0 6px;flex:0 1 auto;min-width:230px;max-width:300px;}
.org-branch.org-peer{min-width:190px;}
.org-branch::before{content:'';position:absolute;top:-22px;left:50%;width:2.5px;height:22px;margin-left:-1px;background:var(--t3);}
.org-branch::after{content:'';position:absolute;top:-22px;left:0;right:0;height:2.5px;background:var(--t3);}
.org-branch:first-child::after{left:50%;}
.org-branch:last-child::after{right:50%;}
.org-branch:only-child::after{display:none;}
.org-branch .org-box{width:100%;min-width:0;}

/* Members: two columns under the NCOIC, on a 12px stub. */
.org-grid{position:relative;margin-top:16px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;}
.org-grid::before{content:'';position:absolute;top:-16px;left:50%;width:2.5px;height:16px;margin-left:-1px;background:var(--t3);}
.org-tile{border:1px solid var(--bm);border-radius:8px;padding:8px 7px;text-align:center;background:var(--cream);}
.org-tile .org-name{font-size:11.5px;margin-top:0;}
.org-role{font-size:7.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--t3-nav);}

/* Shop colour: the source fills each shop's boxes with a saturated hue. The deck
   keeps its own palette — a muted tint of the same hue on the tiles, and the full
   hue as an accent edge on the NCOIC box and every tile — so the shops still read
   as colour-coded without the page looking pasted in from another document. */
.sh-red .org-tile{background:#f5ece9;border-color:#e6d1c9;} .sh-red .org-tile,.sh-red .b-ncoic{border-left:3px solid #a8472f;}
.sh-green .org-tile{background:#edf2eb;border-color:#d3dfd0;} .sh-green .org-tile,.sh-green .b-ncoic{border-left:3px solid #55704f;}
.sh-gray .org-tile{background:#efefeb;border-color:#d9d9d2;} .sh-gray .org-tile,.sh-gray .b-ncoic{border-left:3px solid #8d8e84;}
.sh-blue .org-tile{background:#e9f0f7;border-color:#c9d8e6;} .sh-blue .org-tile,.sh-blue .b-ncoic{border-left:3px solid #2f5c8a;}
.sh-orange .org-tile{background:#f5eedf;border-color:#e6d8bd;} .sh-orange .org-tile,.sh-orange .b-ncoic{border-left:3px solid #b3702c;}
.sh-teal .org-tile{background:#e6f0ef;border-color:#c6dbd9;} .sh-teal .org-tile,.sh-teal .b-ncoic{border-left:3px solid #3f7d78;}
.sh-cyan .org-tile{background:#e7f1f2;border-color:#c7dcde;} .sh-cyan .org-tile,.sh-cyan .b-ncoic{border-left:3px solid #4a8f93;}
.sh-yellow .org-tile{background:#f4f0e0;border-color:#e2dab8;} .sh-yellow .org-tile,.sh-yellow .b-ncoic{border-left:3px solid #8a7326;}
.sh-purple .org-tile{background:#eee9f3;border-color:#d6cbe0;} .sh-purple .org-tile,.sh-purple .b-ncoic{border-left:3px solid #6b5382;}

/* ── Timeline ─────────────────────────────────────────────────────────────
   A horizontal time grid per day: hour ticks in row 1, event bars in rows 2+,
   one row per lane. Columns are 15-minute slots so a 0730 or 0845 start lands
   where it belongs; --cols and --hourw come from the slide, since only the
   shaper knows how long the day runs. */
.tl-wrap{display:flex;flex-direction:column;gap:10px;height:100%;}
.tl-day{display:flex;flex-direction:column;min-width:0;}
.tl-day h3{
  background:var(--text);color:var(--cream);margin:0;padding:4px 12px;
  border-radius:var(--rs) var(--rs) 0 0;font-size:11px;letter-spacing:.04em;
}
.tl-grid{
  display:grid;
  grid-template-columns:repeat(var(--cols),1fr);
  gap:2px;
  align-content:start;
  border:1.5px solid var(--bm);border-top:0;border-radius:0 0 var(--r) var(--r);
  background:#fff;
  /* One hairline per hour, so a bar can be read against the clock. */
  background-image:linear-gradient(to right,var(--bm) 0 1px,transparent 1px);
  background-size:var(--hourw) 100%;
  background-position:0 0;
  padding:0 0 5px;
}
.tl-hour{
  font-size:8.5px;font-weight:700;color:var(--t2);font-variant-numeric:tabular-nums;
  grid-row:1;padding:3px 0 3px 4px;border-bottom:1px solid var(--bm);
  letter-spacing:.02em;
}
.tl-bar{
  min-width:0;overflow:hidden;
  background:var(--s2);border-left:3px solid var(--t3);border-radius:3px;
  padding:3px 5px 4px;margin-top:2px;
  display:flex;flex-direction:column;gap:1px;
}
.tl-t{font-size:7px;font-weight:700;color:var(--t2);font-variant-numeric:tabular-nums;line-height:1.2;}
/* Two lines for a title, two for its summary, then it stops: every bar is drawn at
   least an hour wide, so anything longer than that is the description, not the name. */
.tl-n{font-size:8.5px;font-weight:600;line-height:1.2;overflow-wrap:anywhere;
  display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;}
.tl-det{font-size:7.5px;font-weight:400;color:var(--t2);line-height:1.2;overflow-wrap:anywhere;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}
/* One muted tint per category — the deck's own tokens, so the grid colour-codes the
   day without turning into the source newsletter's rainbow. Formations are the
   anchors of the day and print in ink so the eye finds them first. */
.tl-c-formation{background:var(--text);border-left-color:var(--text);color:var(--cream);}
.tl-c-formation .tl-t,.tl-c-formation .tl-det{color:rgba(246,247,237,.75);}
.tl-c-training{background:var(--info-bg);border-left-color:var(--info);}
.tl-c-meeting,.tl-c-emphasis{background:var(--wrn-bg);border-left-color:var(--warn);}
.tl-c-medical{background:var(--urg-bg);border-left-color:var(--urgent);}
.tl-c-fitness{background:var(--ok-bg);border-left-color:var(--ok);}
.tl-c-ceremony{background:#eee9f3;border-left-color:#6b5382;}
.tl-c-meal{background:var(--cream);border-left-color:var(--t3);}
.tl-c-cleanup{background:var(--bm);border-left-color:var(--t3-nav);}
.tl-c-other{background:var(--cream);border-left-color:var(--t3-nav);}
.tl-body{display:flex;flex-direction:column;height:100%;}
.tl-body .tl-wrap{flex:0 0 auto;height:auto;gap:8px;}
.tl-legend{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:8px;color:var(--t2);padding:7px 2px 0;margin-top:auto;}
.tl-sw{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px;vertical-align:-1px;border-left-width:3px;border-left-style:solid;}
.tl-shop{font-size:7px;background:#fff;color:var(--t2);padding:0 4px;border-radius:999px;font-weight:700;margin-left:3px;border:1px solid var(--bm);}
.tl-notes{display:flex;flex-wrap:wrap;gap:6px;padding:4px 2px 0;}
.tl-note{font-size:8.5px;font-weight:600;background:var(--wrn-bg);color:var(--warn);padding:2px 7px;border-radius:999px;}

/* ── Work schedule: one cream card per shop, three across ───────────────── */
.ws-wrap{columns:3;column-gap:10px;}
.ws-shop{break-inside:avoid;display:inline-block;width:100%;margin:0 0 10px;
  background:var(--cream);border:1.5px solid var(--bm);border-radius:var(--rs);padding:10px 12px;}
.ws-shop h3{font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--t2);margin:0 0 4px;
  display:flex;justify-content:space-between;}
.ws-shop h3 .count{letter-spacing:0;text-transform:none;color:var(--t3-nav);font-weight:600;}
.ws-row{display:flex;gap:7px;padding:5px 0;border-bottom:1px solid var(--hair);font-size:11px;align-items:baseline;}
.ws-row:last-child{border-bottom:0;padding-bottom:1px;}
.ws-wo{color:var(--warn);font-weight:700;white-space:nowrap;font-size:8.5px;flex:0 0 auto;min-width:0;
  max-width:88px;overflow:hidden;text-overflow:ellipsis;}
.ws-t{font-weight:600;line-height:1.3;}
.ws-d{color:var(--t2);font-size:9.5px;line-height:1.35;}

/* ── Generic columns / grids ─────────────────────────────────────────────── */
.two-col{display:flex;gap:26px;}
.col{flex:1;}
.col-hd{font-size:9.5px;font-weight:700;letter-spacing:.13em;text-transform:uppercase;color:var(--t2);margin-bottom:6px;}
.grid-2{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;}
.grid-3{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;}
.grid-4{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;}
.grid-5{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;}
[class^="grid-"] > .card,[class*=" grid-"] > .card{margin:0;}
/* Masonry columns of cards: each card whole, never split across a column. */
.masonry-2{columns:2;column-gap:10px;} .masonry-3{columns:3;column-gap:10px;} .masonry-4{columns:4;column-gap:10px;}
[class^="masonry-"] > .card{break-inside:avoid;display:inline-block;width:100%;margin:0 0 10px;}
.stack > * + *{margin-top:10px;}

/* ── Chips: a name each, so a list of people reads as people, not a paragraph ── */
.chips{display:flex;flex-wrap:wrap;gap:5px 6px;}
.chip{display:inline-flex;align-items:baseline;gap:5px;background:#fff;border:1px solid var(--bm);
  border-radius:999px;padding:3px 10px;font-size:10.5px;font-weight:600;line-height:1.3;}
.chip .sub{font-weight:500;color:var(--t2);font-size:9px;}
.chip.overdue{background:var(--urg-bg);border-color:#e3c9bf;color:var(--urgent);}
.chip.this{background:var(--wrn-bg);border-color:#e3d3ae;color:var(--warn);}
.chip.next{background:var(--ok-bg);border-color:#cfdccb;color:var(--ok);}
.roomy .chip,.chips-lg .chip{font-size:12.5px;padding:5px 13px;}
.roomy .chip .sub,.chips-lg .chip .sub{font-size:10px;}

/* ── Steps: a numbered strip for a how-to (GTC) ── */
.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:10px;}
.step{background:var(--cream);border:1.5px solid var(--bm);border-radius:var(--rs);padding:10px 13px;display:flex;gap:11px;}
.step .n{font-size:24px;font-weight:700;color:var(--t3);line-height:1;}
.step .t{font-size:12px;font-weight:700;margin-bottom:2px;}
.step .s{font-size:10.5px;color:var(--t2);line-height:1.4;}

/* ── Progress bar (upgrade training) ── */
.bar{display:flex;align-items:center;gap:6px;min-width:90px;}
.bar i{flex:1;height:6px;background:#fff;border:1px solid var(--bm);border-radius:4px;overflow:hidden;display:block;}
.bar i b{display:block;height:100%;background:var(--ok);}
.bar span{font-size:9.5px;font-variant-numeric:tabular-nums;color:var(--t2);min-width:28px;text-align:right;}

/* ── RSD: the year as twelve cards ── */
.rsd-list{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(4,1fr);gap:10px;}
.rsd-list li{background:var(--cream);border:1.5px solid var(--bm);border-radius:var(--rs);padding:14px 16px;min-height:168px;}
.rsd-list .mo{font-size:9.5px;font-weight:700;letter-spacing:.13em;text-transform:uppercase;color:var(--t2);margin-bottom:5px;}
.rsd-list .d{font-size:21px;font-weight:700;line-height:1.2;}
.rsd-list .d s{color:var(--t3-nav);font-weight:600;}
.rsd-list .x{font-size:12px;color:var(--t2);margin-top:3px;}
.rsd-list li.next{border:2.5px solid var(--text);}
.rsd-list li.nouta .d{font-size:15px;font-weight:600;color:var(--t3-nav);letter-spacing:.08em;}
.rsd-list li.past{background:#fff;}
.rsd-list li.past .mo{color:var(--t3);}

/* CBT / training blocks. Each course is a cream card; a course with more than a
   dozen names runs them in two sub-columns so the tallest card is still short of
   the page. Name left, status right, so the eye can run down either side. */
.cbt-cols{columns:3;column-gap:10px;}
.cbt-block{break-inside:avoid;display:inline-block;width:100%;margin:0 0 9px;background:var(--cream);
  border:1.5px solid var(--bm);border-radius:var(--rs);padding:8px 10px 6px;}
.cbt-type{font-size:10.5px;font-weight:700;line-height:1.25;display:flex;justify-content:space-between;gap:8px;align-items:baseline;}
.cbt-dur{font-size:9px;font-weight:600;color:var(--t3-nav);white-space:nowrap;}
.cbt-meta{font-size:8.5px;color:var(--t2);margin:1px 0 4px;}
.cbt-block .note{font-size:8.5px;margin:2px 0 4px;}
.cbt-members{margin-top:3px;}
.cbt-members.two{columns:2;column-gap:10px;}
.cbt-line{font-size:9.5px;padding:1px 0;display:flex;justify-content:space-between;gap:6px;
  border-bottom:1px solid var(--hair);break-inside:avoid;}
.cbt-line:last-child{border-bottom:0;}
.cbt-members.two .cbt-line{border-bottom:1px solid var(--hair);}
.cbt-name{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.cbt-status{color:var(--t2);font-size:8.5px;white-space:nowrap;}
.cbt-line .overdue + .cbt-status{color:var(--urgent);}

/* Data table */
.data-table{width:100%;border-collapse:collapse;font-size:10.5px;}
.data-table th{
  text-align:left;padding:4px 8px;font-size:8.5px;letter-spacing:.11em;text-transform:uppercase;
  color:var(--t2);border-bottom:1.5px solid var(--t3);font-weight:700;
}
.data-table td{padding:4px 8px;border-bottom:1px solid var(--hair);vertical-align:top;}
.data-table tr:last-child td{border-bottom:0;}
.data-table td.num{font-variant-numeric:tabular-nums;white-space:nowrap;}
.roomy .data-table{font-size:12px;}
.roomy .data-table th{font-size:9.5px;}

/* Medical: the requirement with the most names leads, and takes two columns of the
   masonry when it is the biggest thing on the page. */
.med-cols{columns:3;column-gap:10px;}
.med-cols > .card{break-inside:avoid;display:inline-block;width:100%;margin:0 0 10px;padding:10px 12px;}
.med-cols .card-hd{margin-bottom:6px;}
.med-cols .note{font-size:9.5px;margin:0 0 7px;}

/* PT: the tests booked for THIS drill lead and take two columns — that card carries
   the test time, which is the one thing anyone needs off this page on Saturday. */
.pt-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;}
.pt-grid > .card{margin:0;}
.pt-grid .lead{grid-column:span 2;}

/* Upgrade training: one table per level. */
.ug-table td.who{font-weight:600;white-space:nowrap;}

/* Static partials keep the app's rhythm */
.static-body{font-size:11px;line-height:1.5;}
.static-body h3{margin-top:10px;}
.static-body table{width:100%;border-collapse:collapse;font-size:10.5px;}
.static-body th{text-align:left;padding:5px 8px;font-size:8.5px;letter-spacing:.1em;
  text-transform:uppercase;color:var(--t2);border-bottom:1.5px solid var(--t3);}
.static-body td{padding:4.5px 8px;border-bottom:1px solid var(--hair);vertical-align:top;}
.static-body tr:last-child td{border-bottom:0;}
.static-body .card table{font-size:11px;}
.static-body .big{font-size:22px;font-weight:700;line-height:1.1;}
.static-body .mid{font-size:14px;font-weight:600;}
.static-body .mil-exam{color:var(--info);font-weight:600;}
.static-body .chips-sm .chip{font-size:9.5px;padding:2px 8px;}
.static-body .chips-sm .chip .sub{font-size:8px;}
.static-body .chips-sm .card{padding:9px 11px;}
.static-body .chips-sm .card-hd{margin-bottom:6px;}
.static-body .slots .card{padding:18px 20px;}
.static-body .slots .big{font-size:40px;}
.static-body .slots .mid{font-size:17px;margin-top:10px;}
.static-body .slots .note{font-size:12.5px;}
.static-body ul{margin:4px 0;padding-left:17px;}
.static-body li{margin-bottom:3px;}

.empty{color:var(--t3-nav);font-size:11px;font-style:italic;padding:10px 0;}

/* Additional duties: two half-tables side by side, each in its own card, so ~50
   rows fit one printed page. */
.duties-cols{display:grid;grid-template-columns:1fr 1fr;gap:10px;align-items:start;}
.duties-cols .card{margin:0;padding:8px 10px;}
.duties-table{width:100%;border-collapse:collapse;font-size:8.6px;}
.duties-table th{text-align:left;padding:4px 7px;font-size:8.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--t2);border-bottom:1.5px solid var(--t3);}
.duties-table td{padding:2.5px 7px;border-bottom:1px solid var(--hair);vertical-align:top;}
.duties-table tr:last-child td{border-bottom:0;}
.duties-table tr.red td{color:var(--urgent);}

/* ── Phones ───────────────────────────────────────────────────────────────────
   The deck is authored at 11in for print. Below that width the slides reflow
   to the viewport instead of showing one corner of a landscape page. Screen
   only — the @page and @media print rules below are untouched, so the PDF a
   member is emailed is byte-identical. */
@media screen and (max-width:1100px){
  .deck{padding:12px;gap:14px;align-items:stretch;}
  .slide{width:100%;height:auto;min-height:0;padding:18px 16px 14px;overflow:visible;}
  .slide-body{overflow:visible;}
  .slide-hd{flex-wrap:wrap;}
  .slide-title{font-size:21px;}
  .toolbar{position:static;flex-wrap:wrap;gap:8px 12px;}
  .toolbar .hint{display:none;}
  .cover{padding:34px 22px;}
  .cover-title{font-size:44px;}
  .cover-meta{position:static;margin-top:26px;flex-direction:column;align-items:flex-start;gap:10px;}
  .cover-stats{flex-wrap:wrap;gap:18px;margin-top:24px;}
  .two-col,.tl-wrap{flex-direction:column;gap:14px;}
  .duties-cols,.steps,.pt-grid,.rsd-list{grid-template-columns:1fr 1fr;}
  .tl-wrap{height:auto;}
  /* A ten-hour grid cannot compress to a phone; scroll it instead of crushing the
     bars into unreadable slivers. The day heading stays put above the scroller. */
  .tl-day{overflow-x:auto;}
  .tl-grid{min-width:660px;}
  .tl-n{font-size:9.5px;}
  .ws-wrap,.cbt-cols,.med-cols,.masonry-2,.masonry-3,.masonry-4{columns:1;}
  .grid-3,.grid-4,.grid-5{grid-template-columns:1fr 1fr;}
  .pt-grid .lead{grid-column:span 2;}
  .org-col{width:calc(50% - 3px);}
  .data-table,.static-body table,.duties-table{display:block;overflow-x:auto;}
  .intro{max-width:none;}
}

/* ── Print ───────────────────────────────────────────────────────────────── */
@page{size:11in 8.5in;margin:0;}
@media print{
  body{background:#fff;}
  .no-print{display:none !important;}
  .deck{gap:0;padding:0;}
  .slide{box-shadow:none;break-after:page;page-break-after:always;}
  .slide:last-child{break-after:auto;page-break-after:auto;}
}
`;

module.exports = { STYLES };
