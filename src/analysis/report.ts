/** Renders the surveillance comparison as one self-contained HTML page (no network, no build step). */
export interface ReportFinding { question: string; analystSays: string; truth: string; fooled: boolean }
export interface ReportColumn {
  title: string; subtitle: string; txid: string;
  inputs: Array<{ label: string; valueSat: number }>;
  outputs: Array<{ label: string; valueSat: number }>;
  findings: ReportFinding[];
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const sat = (n: number) => n.toLocaleString('en-US');

export function renderReport(columns: ReportColumn[]): string {
  const questions = columns[0]?.findings.map((f) => f.question) ?? [];
  const col = (c: ReportColumn, i: number) => `
      <div class="col${i === columns.length - 1 ? ' ours' : ''}">
        <div class="head"><h2>${esc(c.title)}</h2><p>${esc(c.subtitle)}</p></div>
        <div class="tx">
          <div class="side"><span class="cap">inputs</span>
            ${c.inputs.map((x) => `<div class="io"><b>${sat(x.valueSat)}</b><span>${esc(x.label)}</span></div>`).join('')}
          </div>
          <div class="arrow">→</div>
          <div class="side"><span class="cap">outputs</span>
            ${c.outputs.map((x) => `<div class="io"><b>${sat(x.valueSat)}</b><span>${esc(x.label)}</span></div>`).join('')}
          </div>
        </div>
      </div>`;
  const answers = (qi: number) => columns.map((c) => {
    const f = c.findings[qi]!;
    return `<div class="col${f.fooled ? ' fooled' : ' leaked'}">
        <p class="says">“${esc(f.analystSays)}”</p>
        <p class="mark">${f.fooled ? '✗ wrong' : '✓ right'}</p>
        <p class="truth">${esc(f.truth)}</p>
      </div>`;
  }).join('');
  const wrong = (c: ReportColumn) => c.findings.filter((f) => f.fooled).length;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Payment Privacy</title>
<style>
  :root{--bg:#fbfaf7;--fg:#1a1a18;--muted:#6b6862;--line:#e2ded4;--card:#fff;--bad:#b3261e;--good:#146c43;--ours:#1d4ed8}
  @media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#15161a;--fg:#ececee;--muted:#9b9aa3;--line:#2c2e35;--card:#1c1e24;--bad:#ff6b5e;--good:#5ed39a;--ours:#7aa2ff}}
  :root[data-theme=dark]{--bg:#15161a;--fg:#ececee;--muted:#9b9aa3;--line:#2c2e35;--card:#1c1e24;--bad:#ff6b5e;--good:#5ed39a;--ours:#7aa2ff}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;padding:32px 16px 64px}
  main{max-width:1060px;margin:0 auto}
  h1{font-size:clamp(22px,3.4vw,30px);line-height:1.2;margin:0 0 6px;letter-spacing:-.02em}
  .sub{color:var(--muted);margin:0 0 28px;font-size:15px}
  .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
  @media(max-width:760px){.grid{grid-template-columns:1fr}}
  .col{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px}
  .col.ours{border-color:var(--ours);border-width:2px}
  .head h2{font-size:14px;letter-spacing:.08em;text-transform:uppercase;margin:0}
  .head p{margin:2px 0 12px;color:var(--muted);font-size:13px}
  .tx{display:flex;align-items:center;gap:10px}
  .side{flex:1;min-width:0}
  .cap{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:4px}
  .io{display:flex;justify-content:space-between;gap:8px;font-variant-numeric:tabular-nums;font-size:13px;padding:2px 0;border-bottom:1px dashed var(--line)}
  .io span{color:var(--muted)}
  .arrow{color:var(--muted)}
  h3{font-size:15px;margin:30px 0 10px;padding-top:18px;border-top:1px solid var(--line)}
  .says{margin:0 0 8px;font-size:14px}
  .mark{margin:0 0 6px;font-weight:650;font-size:14px}
  .fooled .mark{color:var(--bad)} .leaked .mark{color:var(--good)}
  .truth{margin:0;color:var(--muted);font-size:13px}
  .verdict{margin-top:30px;padding-top:18px;border-top:1px solid var(--line)}
  .score{font-size:13px;color:var(--muted);margin-top:8px;font-variant-numeric:tabular-nums}
  footer{margin-top:34px;color:var(--muted);font-size:12px}
  code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;word-break:break-all}
</style></head><body><main>
  <h1>Alice pays Bob 600,000 sat — three ways</h1>
  <p class="sub">Three real transactions on a regtest chain. A chain-surveillance tool examines each one; its answers are checked against what actually happened.</p>
  <div class="grid">${columns.map(col).join('')}</div>
  ${questions.map((q, i) => `<h3>${esc(q)}</h3><div class="grid">${answers(i)}</div>`).join('')}
  <div class="verdict"><div class="grid">${columns.map((c) => {
    const n = wrong(c);
    return `<div class="col${c === columns[columns.length - 1] ? ' ours' : ''}"><p class="mark" style="color:${n === 0 ? 'var(--bad)' : n >= 2 ? 'var(--good)' : 'inherit'}">${n === 0 ? 'fully exposed' : n === 1 ? 'partly private' : 'surveillance fails'}</p><p class="truth">${n === 0 ? 'Bob is identified, the amount is known, and Alice’s coins are clustered.' : n === 1 ? 'Bob is hidden, but Alice’s coins are still clustered and the amount is right.' : 'Bob is hidden, the amount is wrong, and Alice’s coins are clustered with a stranger’s.'}</p><p class="score">${n}/3 answers wrong</p></div>`;
  }).join('')}</div></div>
  <footer>${columns.map((c) => `<div><code>${esc(c.title)}: ${esc(c.txid)}</code></div>`).join('')}
  <p>BIP352 silent payments give the receiver a fresh key per payment, so there is no address to search for. BIP78 payjoin puts an input from the receiver into the same transaction, so “all inputs share one owner” — the assumption most chain analysis rests on — becomes false.</p></footer>
</main></body></html>`;
}
