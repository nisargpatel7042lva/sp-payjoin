/** The demo console page. Client JS uses \${…} escapes so it survives this template literal. */
export const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Payjoin Console</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>
  :root{color-scheme:light;--ground:#f6f7f9;--card:#fff;--ink:#15181e;--muted:#5d646f;--line:#dde1e8;--exposed:#b33128;--protected:#0e7350;--ours:#2b5bd7}
  @media (prefers-color-scheme:dark){:root{color-scheme:dark;--ground:#0f1216;--card:#171b21;--ink:#e7eaef;--muted:#98a0ad;--line:#252b34;--exposed:#ff7063;--protected:#4ec293;--ours:#84a8ff}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--ground);color:var(--ink);font:15px/1.55 "IBM Plex Sans",system-ui,sans-serif;padding:24px 16px 64px}
  .wrap{max-width:960px;margin:0 auto;display:flex;flex-direction:column;gap:18px}
  .mono{font-family:"IBM Plex Mono",ui-monospace,monospace}
  h1{font-size:22px;margin:0;letter-spacing:-.02em}
  .bar{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between}
  .meta{color:var(--muted);font-size:13px;font-family:"IBM Plex Mono",monospace}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  @media(max-width:720px){.grid{grid-template-columns:1fr}}
  .card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px}
  h2{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin:0 0 10px;font-weight:500;font-family:"IBM Plex Mono",monospace}
  .bal{font-size:26px;font-family:"IBM Plex Mono",monospace;font-variant-numeric:tabular-nums;margin:0}
  .bal small{font-size:13px;color:var(--muted)}
  .addr{font-family:"IBM Plex Mono",monospace;font-size:11px;color:var(--muted);word-break:break-all;margin:8px 0 0;line-height:1.45}
  button{font:inherit;font-size:14px;padding:8px 14px;border-radius:7px;border:1px solid var(--line);background:var(--card);color:var(--ink);cursor:pointer}
  button:hover:not(:disabled){border-color:var(--ours)}
  button:disabled{opacity:.5;cursor:default}
  button.primary{background:var(--ours);border-color:var(--ours);color:#fff;font-weight:500}
  input[type=number]{font:inherit;font-family:"IBM Plex Mono",monospace;padding:8px 10px;border-radius:7px;border:1px solid var(--line);background:var(--ground);color:var(--ink);width:150px}
  .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .toggle{display:flex;align-items:center;gap:8px;font-size:13px}
  .sw{width:40px;height:22px;border-radius:99px;background:var(--line);position:relative;transition:background .15s;border:none;padding:0}
  .sw[aria-pressed=true]{background:var(--protected)}
  .sw::after{content:"";position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .15s}
  .sw[aria-pressed=true]::after{transform:translateX(18px)}
  .feed{display:flex;flex-direction:column;gap:12px}
  .pay{border-left:3px solid var(--line)}
  .pay.joined{border-left-color:var(--protected)}
  .pay.direct{border-left-color:var(--muted)}
  .tag{display:inline-block;font-family:"IBM Plex Mono",monospace;font-size:10px;letter-spacing:.08em;text-transform:uppercase;padding:2px 7px;border-radius:99px;border:1px solid currentColor}
  .tag.joined{color:var(--protected)} .tag.direct{color:var(--muted)}
  .io{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:10px}
  .io ul{list-style:none;margin:4px 0 0;padding:0;font-family:"IBM Plex Mono",monospace;font-size:12px}
  .io li{display:flex;justify-content:space-between;gap:8px;padding:2px 0;border-bottom:1px dotted var(--line)}
  .io .who{color:var(--muted)}
  .io .who.r{color:var(--ours);font-weight:600}
  .q{margin-top:10px;padding-top:10px;border-top:1px solid var(--line);font-size:13px}
  .q div{display:flex;gap:8px;padding:2px 0;align-items:baseline}
  .q b{font-weight:600;font-family:"IBM Plex Mono",monospace;font-size:11px;min-width:58px}
  .wrong{color:var(--protected)} .right{color:var(--exposed)}
  .logs{margin-top:8px;font-family:"IBM Plex Mono",monospace;font-size:11px;color:var(--muted);white-space:pre-wrap}
  .empty{color:var(--muted);font-size:14px}
  .status{font-size:13px;color:var(--muted);min-height:20px}
</style></head><body><div class="wrap">

<div class="bar">
  <div><h1>Payjoin Console</h1><p class="meta" id="meta">connecting…</p></div>
  <div class="toggle"><span>receiver's payjoin endpoint</span><button class="sw" id="sw" aria-pressed="true" aria-label="toggle payjoin"></button><span id="swl" class="mono">on</span></div>
</div>

<div class="grid">
  <div class="card">
    <h2>payer</h2>
    <p class="bal" id="sbal">– <small>sat</small></p>
    <p class="addr" id="saddr"></p>
    <div class="row" style="margin-top:12px"><button id="fund">Fund 0.5 BTC</button></div>
  </div>
  <div class="card">
    <h2>receiver — one static silent payment address</h2>
    <p class="bal" id="rbal">– <small>sat</small></p>
    <p class="addr" id="raddr"></p>
    <p class="addr" id="ruri" style="margin-top:8px"></p>
  </div>
</div>

<div class="card">
  <h2>send a payment</h2>
  <div class="row">
    <input type="number" id="amt" value="400000" min="1000" step="10000" aria-label="amount in sats">
    <span class="meta">sat</span>
    <button class="primary" id="pay">Pay</button>
    <span class="status" id="status">The payer never picks a protocol — payjoin happens if the receiver can.</span>
  </div>
</div>

<div class="feed" id="feed"></div>
</div>
<script>
const $ = (id) => document.getElementById(id);
const n = (v) => v.toLocaleString('en-US');
let busy = false;

async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))).error) || ('HTTP ' + res.status));
  return res.json();
}

function payment(p) {
  const el = document.createElement('div');
  el.className = 'card pay ' + (p.payjoin ? 'joined' : 'direct');
  const ins = p.inputs.map((i) => '<li><span>' + n(i.valueSat) + '</span><span class="who ' + (i.owner === 'receiver' ? 'r' : '') + '">' + i.owner + '</span></li>').join('');
  const outs = p.outputs.map((o) => '<li><span>' + n(o.valueSat) + '</span><span class="who">' + (o.mine ? 'to receiver' : 'payer change') + '</span></li>').join('');
  const qs = p.analyst.map((a) => '<div><b class="' + (a.fooled ? 'wrong' : 'right') + '">' + (a.fooled ? 'WRONG' : 'right') + '</b><span>' + a.question + ' “' + a.says + '”' + (a.fooled ? ' — actually ' + a.truth : '') + '</span></div>').join('');
  el.innerHTML =
    '<div class="row" style="justify-content:space-between">' +
      '<span class="tag ' + (p.payjoin ? 'joined' : 'direct') + '">' + (p.payjoin ? 'payjoin — receiver contributed an input' : 'direct silent payment') + '</span>' +
      '<span class="meta">' + n(p.amountSat) + ' sat</span>' +
    '</div>' +
    (p.reason ? '<p class="meta" style="margin:8px 0 0">fell back: ' + p.reason + '</p>' : '') +
    '<div class="io"><div><h2>inputs</h2><ul>' + ins + '</ul></div><div><h2>outputs</h2><ul>' + outs + '</ul></div></div>' +
    '<div class="q"><h2>what a chain-analysis tool concludes</h2>' + qs + '</div>' +
    '<p class="addr" style="margin-top:10px">' + p.txid + '</p>' +
    '<div class="logs">' + p.log.map((l) => '· ' + l).join('\\n') + '</div>';
  return el;
}

async function refresh() {
  try {
    const s = await api('/api/state');
    $('meta').textContent = 'regtest · block ' + s.height + ' · receiver has ' + s.receiver.utxos + ' utxo' + (s.receiver.utxos === 1 ? '' : 's') + ' · ' + s.receiver.exposed + ' exposed to senders';
    $('sbal').innerHTML = n(s.sender.balanceSat) + ' <small>sat</small>';
    $('rbal').innerHTML = n(s.receiver.balanceSat) + ' <small>sat</small>';
    $('saddr').textContent = s.sender.address;
    $('raddr').textContent = s.receiver.address;
    $('ruri').textContent = s.receiver.uri;
    $('sw').setAttribute('aria-pressed', String(s.payjoinEnabled));
    $('swl').textContent = s.payjoinEnabled ? 'on' : 'off';
    const feed = $('feed');
    feed.replaceChildren();
    if (!s.history.length) {
      const e = document.createElement('p');
      e.className = 'empty';
      e.textContent = 'No payments yet. Fund the payer, then press Pay. Pay twice: the first payment gives the receiver a coin, so the second one can be joined.';
      feed.append(e);
    } else s.history.forEach((p) => feed.append(payment(p)));
  } catch (e) { $('meta').textContent = 'cannot reach the server: ' + e.message; }
}

$('fund').onclick = async () => {
  if (busy) return; busy = true; $('fund').disabled = true; $('status').textContent = 'funding…';
  try { await api('/api/fund', {}); $('status').textContent = 'funded.'; } catch (e) { $('status').textContent = e.message; }
  busy = false; $('fund').disabled = false; refresh();
};

$('pay').onclick = async () => {
  if (busy) return; busy = true; $('pay').disabled = true; $('status').textContent = 'building, asking the receiver, broadcasting…';
  try {
    const r = await api('/api/pay', { amountSat: Number($('amt').value) });
    $('status').textContent = r.summary;
  } catch (e) { $('status').textContent = 'failed: ' + e.message; }
  busy = false; $('pay').disabled = false; refresh();
};

$('sw').onclick = async () => {
  const next = $('sw').getAttribute('aria-pressed') !== 'true';
  await api('/api/payjoin', { enabled: next });
  $('status').textContent = next ? 'Receiver advertises a payjoin endpoint again.' : 'Receiver is now a plain silent-payment wallet — the same Pay button will fall back.';
  refresh();
};

refresh();
setInterval(refresh, 4000);
</script></body></html>`;
