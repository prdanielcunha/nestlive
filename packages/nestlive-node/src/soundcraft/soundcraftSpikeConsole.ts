import type { SoundcraftSpikeStatus } from './soundcraftSpikeCoordinator';

function esc(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function renderSoundcraftSpikeConsole(
  status: SoundcraftSpikeStatus
): string {
  const statusJson = JSON.stringify(status).replaceAll('<', '\\u003c');

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>NestLive · Soundcraft Physical Spike</title>
<style>
:root{color-scheme:dark;font-family:Inter,system-ui,sans-serif;background:#0b0c11;color:#f4f5f8}*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:radial-gradient(circle at 70% 0,#221c4c,transparent 38%),#0b0c11;padding:26px}
main{width:min(900px,100%);margin:auto}.card{border:1px solid rgba(255,255,255,.09);border-radius:22px;background:rgba(18,19,26,.9);padding:22px;margin-bottom:12px}
.eyebrow{font-size:11px;letter-spacing:.14em;color:#a99aff;font-weight:700}h1{font-size:34px;letter-spacing:-.04em;margin:6px 0 10px}
p,small{color:#9ca1b2;line-height:1.55}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}.metric{padding:12px;border-radius:13px;background:rgba(255,255,255,.035)}
.metric span{display:block;color:#8f94a5;font-size:10px}.metric strong{font-size:19px}.form{display:grid;gap:10px}
label{display:grid;gap:5px;font-size:11px;color:#9ca1b2}input,textarea{width:100%;border:1px solid rgba(255,255,255,.1);background:#0e0f15;color:#fff;border-radius:11px;padding:11px}
button,a.btn{display:inline-flex;align-items:center;justify-content:center;min-height:42px;border-radius:11px;border:1px solid rgba(124,92,255,.28);background:rgba(124,92,255,.13);color:#fff;padding:0 14px;text-decoration:none;cursor:pointer}
.danger{border-color:rgba(232,90,104,.28);background:rgba(232,90,104,.08)}.row{display:flex;gap:8px;flex-wrap:wrap}.notice{padding:12px;border-radius:12px;border:1px solid rgba(74,141,255,.2);background:rgba(74,141,255,.07);color:#b7caef}
#result{white-space:pre-wrap;font:12px ui-monospace,monospace;color:#b9bdcb}@media(max-width:650px){.grid{grid-template-columns:1fr 1fr}}
</style>
</head>
<body>
<main>
<section class="card">
<span class="eyebrow">SOUNDCRAFT SI EXPRESSION · INDUSTRIAL</span>
<h1>Physical Spike</h1>
<p>Captura HiQnet somente leitura. O NestLive registra tráfego e marcadores, mas não envia comandos para a mesa nesta etapa.</p>
<div class="notice">Faça uma alteração física por vez na mesa e registre um marcador antes de cada ação.</div>
</section>
<section class="card">
<div class="grid">
<div class="metric"><span>SESSÃO</span><strong id="active">${status.active ? 'ATIVA' : 'PARADA'}</strong></div>
<div class="metric"><span>FRAMES</span><strong id="frames">${status.frames}</strong></div>
<div class="metric"><span>MARCADORES</span><strong id="markers">${status.markers}</strong></div>
<div class="metric"><span>DROP</span><strong id="drops">${status.droppedFrames}</strong></div>
</div>
</section>
<section class="card form">
<label>IPv4 da interface dedicada (opcional)<input id="localAddress" placeholder="192.168.x.x"></label>
<label>Firmware observado (opcional)<input id="firmware" placeholder="versão exibida na mesa"></label>
<div class="row"><button id="start">Iniciar captura</button><button id="stop" class="danger">Parar e salvar evidência</button></div>
</section>
<section class="card form">
<label>Ação física<input id="action" placeholder="Ex.: mover fader CH 1 de -20 para -10 dB"></label>
<label>O que esperamos observar<input id="expected" placeholder="Ex.: delta repetível em frames após o movimento"></label>
<label>Nota<textarea id="note" rows="3"></textarea></label>
<button id="mark">Registrar marcador</button>
</section>
<section class="card"><strong>Resultado</strong><pre id="result"></pre><a class="btn" href="/local">Voltar ao NestLive Node</a></section>
</main>
<script>
let state=${statusJson};
const result=document.querySelector('#result');
async function call(path,body){
  const response=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})});
  const data=await response.json();
  if(!response.ok) throw new Error(data.error||'request_failed');
  state=data.status||state; render();
  result.textContent=JSON.stringify(data,null,2);
}
function render(){
 document.querySelector('#active').textContent=state.active?'ATIVA':'PARADA';
 document.querySelector('#frames').textContent=String(state.frames||0);
 document.querySelector('#markers').textContent=String(state.markers||0);
 document.querySelector('#drops').textContent=String(state.droppedFrames||0);
}
document.querySelector('#start').onclick=()=>call('/local/soundcraft-spike/start',{
 localAddress:document.querySelector('#localAddress').value.trim()||undefined,
 firmware:document.querySelector('#firmware').value.trim()||undefined
}).catch(e=>result.textContent=e.message);
document.querySelector('#mark').onclick=()=>call('/local/soundcraft-spike/mark',{
 action:document.querySelector('#action').value,
 expectedObservation:document.querySelector('#expected').value,
 note:document.querySelector('#note').value
}).catch(e=>result.textContent=e.message);
document.querySelector('#stop').onclick=()=>call('/local/soundcraft-spike/stop',{}).catch(e=>result.textContent=e.message);
setInterval(async()=>{try{const r=await fetch('/local/soundcraft-spike/status',{cache:'no-store'});if(r.ok){const d=await r.json();state=d.status;render()}}catch{}},1000);
</script>
</body></html>`;
}
