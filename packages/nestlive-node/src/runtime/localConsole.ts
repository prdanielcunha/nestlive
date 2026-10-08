import QRCode from 'qrcode';
import type { LocalPairingDisplay } from '../security/pairingManager';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export async function renderNestLiveLocalConsole(input: {
  displayName: string;
  pairUrl?: string;
  pairings: LocalPairingDisplay[];
  providers: string[];
  soundcraftSpikeUrl?: string;
}): Promise<string> {
  const qr = input.pairUrl
    ? await QRCode.toString(input.pairUrl, {
        type: 'svg',
        margin: 1,
        width: 230
      })
    : '';

  const pairings = input.pairings.length
    ? input.pairings
        .map(
          pairing => `
            <section class="pin">
              <span>PIN para ${escapeHtml(pairing.deviceName)}</span>
              <strong>${escapeHtml(pairing.pin)}</strong>
              <small>Expira em ${escapeHtml(
                new Date(pairing.expiresAt).toLocaleTimeString('pt-BR')
              )}</small>
            </section>`
        )
        .join('')
    : '<p class="muted">Nenhum dispositivo aguardando confirmação.</p>';

  const providers = input.providers.length
    ? input.providers.map(value => `<span class="chip">${escapeHtml(value)}</span>`).join('')
    : '<span class="chip">Nenhuma mesa conectada</span>';

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="2">
<title>NestLive Node</title>
<style>
:root{color-scheme:dark;font-family:Inter,system-ui,sans-serif;background:#0b0c11;color:#f4f5f8}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(circle at 70% 0,#261f58 0,transparent 38%),#0b0c11}
main{width:min(920px,100%);display:grid;grid-template-columns:1fr 320px;gap:18px}
.card{background:rgba(18,19,26,.88);border:1px solid rgba(255,255,255,.09);border-radius:24px;padding:26px;box-shadow:0 24px 80px rgba(0,0,0,.3)}
.eyebrow{font-size:11px;letter-spacing:.14em;color:#a99aff;font-weight:700}h1{font-size:38px;letter-spacing:-.04em;margin:8px 0 10px}.muted{color:#9ca1b2;line-height:1.55}.qr{background:#fff;border-radius:18px;padding:14px;margin-top:18px;display:grid;place-items:center}.qr svg{width:100%;height:auto}.chip{display:inline-flex;padding:7px 10px;border:1px solid rgba(255,255,255,.08);border-radius:999px;margin:4px 6px 4px 0;color:#c9ccd8;font-size:12px}.pin{margin-top:14px;padding:18px;border-radius:18px;background:rgba(124,92,255,.1);border:1px solid rgba(124,92,255,.22);display:flex;flex-direction:column;gap:7px}.pin span,.pin small{color:#b9b5c9}.pin strong{font-size:44px;letter-spacing:.15em;font-variant-numeric:tabular-nums}.url{overflow-wrap:anywhere;color:#a99aff;font-size:12px}.tech-link{color:#b8aaff;text-decoration:none;font-size:12px}.tech-link:hover{text-decoration:underline}
@media(max-width:720px){main{grid-template-columns:1fr}h1{font-size:30px}}
</style>
</head>
<body>
<main>
<section class="card">
<span class="eyebrow">NESTLIVE NODE</span>
<h1>${escapeHtml(input.displayName)}</h1>
<p class="muted">Este computador faz a ponte segura entre o NestLive e os equipamentos da igreja. A mesa nunca é exposta diretamente à internet.</p>
<div>${providers}</div>
<p><a class="tech-link" href="/production/" style="display:inline-block;padding:13px 17px;margin-top:14px;border-radius:13px;background:#7965ed;color:#fff;font-size:14px;font-weight:700">Abrir painel de produção →</a></p>
${input.soundcraftSpikeUrl
  ? `<p><a class="tech-link" href="${escapeHtml(input.soundcraftSpikeUrl)}">Ferramenta técnica · Soundcraft Physical Spike</a></p>`
  : ''}
${
  input.pairUrl
    ? `<div class="qr">${qr}</div><p class="muted">Escaneie com o celular ou iPad para abrir o NestLive.</p><p class="url">${escapeHtml(input.pairUrl)}</p>`
    : '<p class="muted">Conecte este PC à rede principal da igreja para gerar o QR.</p>'
}
</section>
<section class="card">
<span class="eyebrow">PAREAMENTO</span>
<h2>Confirme no computador</h2>
<p class="muted">O PIN só aparece aqui. O dispositivo remoto recebe acesso apenas depois da confirmação física.</p>
${pairings}
</section>
</main>
</body>
</html>`;
}
