// newsletter/theme.js — the newsletter's visual layer, in the app's design language.
//
// Replaces the previous navy/serif "PowerPoint" look. Every token here is copied
// from public/design.css so the printed newsletter and the web app read as one
// product: same cream page, same card treatment, same urgency colours, same
// typeface. General Sans is inlined as base64 so the HTML is a single portable
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
  --r:14px; --rs:10px;
}

*{box-sizing:border-box;}
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
  background:transparent;color:var(--cream);opacity:.85;
  border:1px solid rgba(255,255,255,.3);padding:6px 14px;white-space:nowrap;
}
.toolbar button.back:hover{opacity:1;background:rgba(255,255,255,.12);}

.deck{display:flex;flex-direction:column;align-items:center;gap:20px;padding:20px;}

/* ── Slide = one landscape page ──────────────────────────────────────────── */
.slide{
  background:var(--cream);
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
.slide-ft{
  margin-top:auto;padding-top:9px;display:flex;justify-content:space-between;
  font-size:9.5px;color:var(--t3-nav);border-top:1.5px solid var(--bm);
}

/* ── Card: the single repeated motif, straight from the app ──────────────── */
.card{background:var(--bg);border:2px solid var(--border);border-radius:var(--r);padding:13px 15px;}
.card + .card{margin-top:9px;}
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
.p-row{display:flex;align-items:baseline;gap:7px;padding:3.5px 0;border-bottom:1px solid var(--border);}
.p-row:last-child{border-bottom:0;}
.p-name{font-weight:600;font-size:11.5px;}
.p-note{color:var(--t2);font-size:10.5px;overflow-wrap:anywhere;}
.p-spacer{flex:1;}

/* ── Cover ───────────────────────────────────────────────────────────────── */
.cover{background:#26281f;color:var(--cream);justify-content:center;padding:.9in 1in;position:relative;}
.cover-eyebrow{font-size:12px;font-weight:700;letter-spacing:.22em;color:#a9ab9e;text-transform:uppercase;}
.cover-title{font-size:82px;font-weight:700;line-height:1;margin:16px 0 0;letter-spacing:-.015em;}
.cover-sub{font-size:20px;color:#a9ab9e;margin-top:18px;font-weight:500;}
.cover-meta{
  position:absolute;left:1in;right:1in;bottom:.85in;
  display:flex;justify-content:space-between;align-items:flex-end;
  font-size:11px;color:#a9ab9e;
}
.cover-url{font-size:15px;font-weight:600;color:var(--cream);}
.cover-stats{display:flex;gap:34px;margin-top:40px;}
.cover-stat .n{font-size:34px;font-weight:700;line-height:1;}
.cover-stat .l{font-size:10.5px;color:#a9ab9e;margin-top:5px;letter-spacing:.05em;text-transform:uppercase;}

/* ── Org chart ───────────────────────────────────────────────────────────── */
.org .slide-body{font-size:10px;display:flex;flex-direction:column;justify-content:center;}
.org-staff{display:flex;gap:6px;justify-content:center;flex-wrap:wrap;margin-bottom:9px;}
.org-leaders{display:flex;justify-content:center;gap:8px;margin:0 0 10px;}
.org-box{
  border:1.5px solid var(--bm);border-radius:var(--rs);padding:5px 10px;text-align:center;
  min-width:112px;background:var(--bg);
}
.org-pos{font-size:7.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--t2);}
.org-name{font-size:11px;font-weight:600;margin-top:1px;}
.b-cmd,.b-oic{background:var(--text);color:var(--cream);border-color:var(--text);}
.b-cmd .org-pos,.b-oic .org-pos,.b-chief .org-pos,.b-1sg .org-pos,.b-supt .org-pos{color:rgba(246,247,237,.72);}
.b-chief{background:#3d4036;color:var(--cream);border-color:#3d4036;}
.b-1sg{background:var(--urgent);color:#fff;border-color:var(--urgent);}
.b-1sg .org-pos{color:rgba(255,255,255,.8);}
.b-admin{background:var(--s2);}
.b-supt{background:var(--text);color:var(--cream);border-color:var(--text);}
.b-ncoic{background:var(--cream);border-color:var(--t3);}
.org-shops{display:flex;gap:6px;justify-content:center;align-items:flex-start;flex-wrap:wrap;}
.org-col{display:flex;flex-direction:column;gap:4px;width:143px;}
.org-tiles{display:flex;flex-direction:column;gap:2.5px;}
.org-tile{
  border:1px solid var(--border);border-radius:7px;padding:3px 6px;text-align:center;background:var(--bg);
}
.org-tile .org-name{font-size:10px;}
.org-role{font-size:7px;text-transform:uppercase;letter-spacing:.05em;color:var(--t3-nav);}
/* Shop accents: one muted hue per shop rather than nine saturated fills. */
.sh-red{border-left:3px solid #a8472f;} .sh-green{border-left:3px solid #55704f;}
.sh-gray{border-left:3px solid #8d8e84;} .sh-blue{border-left:3px solid #2f5c8a;}
.sh-orange{border-left:3px solid #b3702c;} .sh-teal{border-left:3px solid #3f7d78;}
.sh-cyan{border-left:3px solid #4a8f93;} .sh-yellow{border-left:3px solid #8a7326;}
.sh-purple{border-left:3px solid #6b5382;}

/* ── Timeline ────────────────────────────────────────────────────────────── */
.tl-wrap{display:flex;gap:12px;height:100%;}
.tl-day{flex:1;min-width:0;display:flex;flex-direction:column;}
.tl-day h3{
  background:var(--text);color:var(--cream);margin:0;padding:5px 12px;
  border-radius:var(--rs) var(--rs) 0 0;font-size:11.5px;letter-spacing:.04em;
}
.tl-list{border:2px solid var(--border);border-top:0;border-radius:0 0 var(--r) var(--r);
  background:var(--bg);padding:4px 12px 8px;flex:1;}
.tl-row{display:flex;gap:10px;padding:4px 0;border-bottom:1px solid var(--border);}
.tl-row:last-child{border-bottom:0;}
.tl-time{font-size:10px;font-weight:700;color:var(--t2);width:76px;flex-shrink:0;font-variant-numeric:tabular-nums;}
.tl-what{font-size:11px;font-weight:500;flex:1;min-width:0;overflow-wrap:anywhere;}
.tl-emph{background:var(--wrn-bg);margin:0 -12px;padding-left:12px;padding-right:12px;}
.tl-shop{font-size:8.5px;background:var(--s2);color:var(--t2);padding:1px 6px;border-radius:999px;font-weight:600;}

/* ── Work schedule ───────────────────────────────────────────────────────── */
.ws-wrap{columns:2;column-gap:16px;}
.ws-shop{break-inside:avoid;margin-bottom:9px;}
.ws-shop h3{font-size:10px;letter-spacing:.11em;text-transform:uppercase;color:var(--t2);margin-bottom:4px;}
.ws-row{display:flex;gap:8px;padding:3px 0;border-bottom:1px solid var(--border);font-size:10.5px;}
.ws-wo{color:var(--warn);font-weight:700;white-space:nowrap;font-size:10px;}

/* ── Generic columns / grids ─────────────────────────────────────────────── */
.two-col{display:flex;gap:26px;}
.col{flex:1;}
.col-hd{font-size:9.5px;font-weight:700;letter-spacing:.13em;text-transform:uppercase;color:var(--t2);margin-bottom:6px;}
.grid-3{display:grid;grid-template-columns:repeat(3,1fr);gap:9px;}
.grid-4{display:grid;grid-template-columns:repeat(4,1fr);gap:9px;}
.grid-2{display:grid;grid-template-columns:repeat(2,1fr);gap:9px;}

/* CBT / training blocks */
.cbt-cols{columns:3;column-gap:14px;}
.cbt-block{break-inside:avoid;margin-bottom:10px;background:var(--bg);
  border:2px solid var(--border);border-radius:var(--rs);padding:9px 11px;}
.cbt-type{font-size:10.5px;font-weight:700;margin-bottom:5px;line-height:1.25;}
.cbt-line{font-size:10.5px;padding:1.5px 0;}
.cbt-status{color:var(--t2);font-size:9.5px;}

/* Data table */
.data-table{width:100%;border-collapse:collapse;font-size:10.5px;}
.data-table th{
  text-align:left;padding:4px 8px;font-size:8.5px;letter-spacing:.11em;text-transform:uppercase;
  color:var(--t2);border-bottom:1.5px solid var(--bm);font-weight:700;
}
.data-table td{padding:3.5px 8px;border-bottom:1px solid var(--border);vertical-align:top;}

/* EPB / medical / inbound lines */
.epb-line,.med-line,.io-line{font-size:11px;padding:3px 0;border-bottom:1px solid var(--border);}
.med-grid{display:flex;gap:18px;}
.med-list{flex:1.55;columns:2;column-gap:16px;}
.med-steps{flex:1;}
.med-steps ul{margin:0;padding-left:16px;font-size:10.5px;color:var(--t2);line-height:1.5;}
.med-steps li{margin-bottom:5px;}

/* PT / upgrade cards */
.pt-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:9px;}
.pt-card{background:var(--bg);border:2px solid var(--border);border-radius:var(--rs);padding:9px 11px;font-size:10.5px;}
.pt-hd{font-size:9.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--t2);margin-bottom:6px;}
.pt-card div{padding:1.5px 0;}
.ug-cols{display:flex;gap:16px;}
.ug-col{flex:1;}
.ug-card{background:var(--bg);border:2px solid var(--border);border-radius:var(--rs);
  padding:7px 10px;margin-bottom:6px;font-size:10.5px;}

/* Static partials keep the app's rhythm */
.static-body{font-size:11px;line-height:1.5;}
.static-body h3{margin-top:10px;}
.static-body table{width:100%;border-collapse:collapse;font-size:10px;}
.static-body th{text-align:left;padding:4px 7px;font-size:8.5px;letter-spacing:.1em;
  text-transform:uppercase;color:var(--t2);border-bottom:1.5px solid var(--bm);}
.static-body td{padding:3px 7px;border-bottom:1px solid var(--border);vertical-align:top;}
.static-body ul{margin:4px 0;padding-left:17px;}
.static-body li{margin-bottom:3px;}

.empty{color:var(--t3-nav);font-size:11px;font-style:italic;padding:10px 0;}

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
