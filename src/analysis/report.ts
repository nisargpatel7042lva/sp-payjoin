/**
 * Renders the surveillance comparison as HTML.
 *   renderReportBody()  → title + styles + content (no document skeleton)
 *   renderReport()      → the same wrapped as a standalone file for `out/report.html`
 * One source so the local file and any hosted copy cannot drift apart.
 */
export interface ReportFinding { question: string; analystSays: string; truth: string; fooled: boolean }
export interface ReportColumn {
  title: string; subtitle: string; txid: string;
  inputs: Array<{ label: string; valueSat: number }>;
  outputs: Array<{ label: string; valueSat: number }>;
  findings: ReportFinding[];
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const sat = (n: number) => n.toLocaleString('en-US');

const STYLE = `
  :root{
    color-scheme: light;
    --ground:#f6f7f9; --card:#ffffff; --ink:#15181e; --muted:#5d646f; --line:#dde1e8;
    --exposed:#b33128; --protected:#0e7350; --ours:#2b5bd7; --shadow:0 1px 2px rgba(20,24,33,.06);
  }
  @media (prefers-color-scheme: dark){ :root:not([data-theme="light"]){
    color-scheme: dark;
    --ground:#0f1216; --card:#171b21; --ink:#e7eaef; --muted:#98a0ad; --line:#252b34;
    --exposed:#ff7063; --protected:#4ec293; --ours:#84a8ff; --shadow:none;
  }}
  :root[data-theme="dark"]{
    color-scheme: dark;
    --ground:#0f1216; --card:#171b21; --ink:#e7eaef; --muted:#98a0ad; --line:#252b34;
    --exposed:#ff7063; --protected:#4ec293; --ours:#84a8ff; --shadow:none;
  }
  *{box-sizing:border-box}
  body{
    margin:0; background:var(--ground); color:var(--ink);
    font:16px/1.55 "IBM Plex Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    padding-inline:16px; padding-block:40px 64px;
  }
  .wrap{max-width:1080px;margin:0 auto;display:flex;flex-direction:column;gap:34px}
  .mono{font-family:"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace}
  h1{font-size:clamp(24px,3.6vw,34px);line-height:1.15;letter-spacing:-.02em;margin:0;text-wrap:balance}
  .lede{margin:10px 0 0;color:var(--muted);max-width:62ch}
  .eyebrow{font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin:0 0 10px}
  .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;align-items:start}
  @media (max-width:820px){ .grid{grid-template-columns:1fr} }
  .card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;box-shadow:var(--shadow)}
  .card.ours{border-color:var(--ours)}
  .name{font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:12px;letter-spacing:.1em;text-transform:uppercase;margin:0}
  .name.ours{color:var(--ours)}
  .sub{margin:3px 0 14px;color:var(--muted);font-size:13px}
  .flow{display:flex;gap:12px;align-items:stretch}
  .leg{flex:1;min-width:0}
  .leg h4{font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin:0 0 6px;font-weight:500}
  .io{display:flex;justify-content:space-between;gap:8px;padding:3px 0;border-bottom:1px dotted var(--line);font-size:13px}
  .io b{font-family:"IBM Plex Mono",ui-monospace,monospace;font-weight:600;font-variant-numeric:tabular-nums}
  .io span{color:var(--muted);white-space:nowrap}
  .join{color:var(--ours);font-weight:600}
  .to{align-self:center;color:var(--muted);font-size:18px}
  .pips{display:flex;gap:5px;align-items:center;margin-top:14px;padding-top:12px;border-top:1px solid var(--line)}
  .pip{width:11px;height:11px;border-radius:50%;border:1.5px solid var(--protected)}
  .pip.hit{background:var(--exposed);border-color:var(--exposed)}
  .pips span{font-size:12px;color:var(--muted);margin-left:5px}
  .q{display:flex;flex-direction:column;gap:12px}
  .q > h3{margin:0;font-size:17px;letter-spacing:-.01em}
  .ans{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:9px;box-shadow:var(--shadow)}
  .ans.ours{border-color:var(--ours)}
  .says{margin:0;font-size:14px}
  .says::before{content:"“"} .says::after{content:"”"}
  .tag{display:inline-flex;align-items:center;gap:6px;align-self:flex-start;font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:11px;letter-spacing:.08em;text-transform:uppercase;padding:3px 8px;border-radius:999px;border:1px solid currentColor}
  .tag.right{color:var(--exposed)} .tag.wrong{color:var(--protected)}
  .truth{margin:0;color:var(--muted);font-size:13px}
  .final{border-top:1px solid var(--line);padding-top:22px}
  .score{font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:26px;font-variant-numeric:tabular-nums;margin:0 0 4px}
  .foot{color:var(--muted);font-size:13px;border-top:1px solid var(--line);padding-top:18px;display:flex;flex-direction:column;gap:12px}
  .foot p{margin:0;max-width:74ch}
  .txids{display:flex;flex-direction:column;gap:3px;font-size:11px;overflow-x:auto}
`;

function renderReportBody(columns: ReportColumn[]): string {
  const questions = columns[0]?.findings.map((f) => f.question) ?? [];
  const wrongCount = (c: ReportColumn) => c.findings.filter((f) => f.fooled).length;
  const isOurs = (i: number) => i === columns.length - 1;

  const scenario = (c: ReportColumn, i: number) => `
        <div class="card${isOurs(i) ? ' ours' : ''}">
          <p class="name${isOurs(i) ? ' ours' : ''}">${esc(c.title)}</p>
          <p class="sub">${esc(c.subtitle)}</p>
          <div class="flow">
            <div class="leg"><h4>inputs</h4>${c.inputs.map((x) => `<div class="io"><b>${sat(x.valueSat)}</b><span${x.label === 'Bob' ? ' class="join"' : ''}>${esc(x.label)}</span></div>`).join('')}</div>
            <div class="to">→</div>
            <div class="leg"><h4>outputs</h4>${c.outputs.map((x) => `<div class="io"><b>${sat(x.valueSat)}</b><span>${esc(x.label)}</span></div>`).join('')}</div>
          </div>
          <div class="pips">${c.findings.map((f) => `<i class="pip${f.fooled ? '' : ' hit'}" aria-hidden="true"></i>`).join('')}<span>${3 - wrongCount(c)} of 3 answers correct</span></div>
        </div>`;

  const answer = (c: ReportColumn, qi: number, i: number) => {
    const f = c.findings[qi]!;
    return `
        <div class="ans${isOurs(i) ? ' ours' : ''}">
          <p class="says">${esc(f.analystSays)}</p>
          <span class="tag ${f.fooled ? 'wrong' : 'right'}">${f.fooled ? 'wrong' : 'correct'}</span>
          <p class="truth">${esc(f.truth)}</p>
        </div>`;
  };

  const verdictText = (n: number) => n === 0
    ? 'Everything leaks: who was paid, how much, and which coins belong to the payer.'
    : n === 1
      ? 'The receiver is hidden, but the payer’s coins are still clustered and the amount is public.'
      : 'Who was paid, how much, and whose coins — all three answers are wrong.';

  return `<div class="wrap">
  <header>
    <p class="eyebrow">bip352 silent payments · bip78 payjoin · regtest</p>
    <h1>Alice pays Bob 600,000 sat — three ways</h1>
    <p class="lede">Three real transactions, mined on a regtest chain. A chain-surveillance tool examines each one and answers the same three questions. Because we hold the keys, every answer can be marked against what actually happened.</p>
  </header>

  <section class="grid">${columns.map(scenario).join('')}</section>

  ${questions.map((q, qi) => `<section class="q">
    <h3>${esc(q)}</h3>
    <div class="grid">${columns.map((c, i) => answer(c, qi, i)).join('')}</div>
  </section>`).join('')}

  <section class="final">
    <p class="eyebrow">verdict</p>
    <div class="grid">${columns.map((c, i) => {
      const n = wrongCount(c);
      return `<div class="card${isOurs(i) ? ' ours' : ''}">
        <p class="score mono" style="color:${n === 0 ? 'var(--exposed)' : n >= 2 ? 'var(--protected)' : 'var(--ink)'}">${3 - n}/3</p>
        <p class="truth">${verdictText(n)}</p>
      </div>`;
    }).join('')}</div>
  </section>

  <footer class="foot">
    <p>Silent payments give the receiver a fresh key for every payment, so there is no address on the chain to search for. Payjoin puts an input from the receiver into the same transaction, so “every input belongs to one owner” — the assumption most chain analysis rests on — stops being true.</p>
    <p>The analyst here applies three textbook heuristics, not a commercial product with clustering history or exchange records. An analyst who suspects payjoin can subtract the receiver’s contribution; the point is that the shared-ownership assumption becomes unreliable for every transaction, not that any single one is undetectable.</p>
    <div class="txids mono">${columns.map((c) => `<div>${esc(c.title)} — ${esc(c.txid)}</div>`).join('')}</div>
  </footer>
</div>`;
}

const HEAD = `<title>Surveillance Scorecard</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>${STYLE}</style>`;

/** Body-only fragment: the hosting platform supplies the document skeleton. */
export function renderReportFragment(columns: ReportColumn[]): string {
  return `${HEAD}\n${renderReportBody(columns)}`;
}

/** Standalone document for opening straight off disk. */
export function renderReport(columns: ReportColumn[]): string {
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">',
    HEAD,
    '</head><body>',
    renderReportBody(columns),
    '</body></html>',
  ].join('\n');
}
