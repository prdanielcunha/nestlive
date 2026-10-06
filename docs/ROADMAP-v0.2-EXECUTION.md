# Roadmap v0.2 — execução no NestLive

**Início:** 04/10/2026  
**Atualização:** 06/10/2026

| Fase | Estado de software | Certificação física |
|---|---|---|
| A0 — contratos de áudio e multi-rede | **concluído em software** | n/a |
| A1 — Multi-network Node | **concluído em software** | pendente nos PCs reais |
| A2 — Meter Engine | **concluído em software** | soak lógico concluído; hardware pendente |
| A3 — X32 | **implementado com deep controls fail-closed** | pendente Monte Castelo |
| A4 — Mix UI premium | **implementado** | validar ergonomia no culto real |
| A5 — Soundcraft physical spike | **wizard/harness read-only implementado** | pendente Industrial |
| A6 — Soundcraft production provider | **provider/certification shell implementado** | writes bloqueados até A5 |
| A7 — Signal Trace + Audio Doctor | **implementado** | validar com telemetria real |
| A8 — Soundcheck + Scale Context | **implementado e integrado ao MusicScale** | validar fluxo real |
| A9 — Remote Mix | **software end-to-end implementado** | relay cloud/deploy + teste externo pendentes |

## A0 — contratos

Entregue:

- domínio neutro de áudio;
- capability set;
- safety levels;
- `MeterFrame`;
- `NetworkInterface`;
- `ProviderNetworkBinding`;
- simulador;
- contratos do relay remoto;
- testes.

## A1 — Multi-network Node

Entregue:

- enumeração/classificação de interfaces;
- descoberta sem IP no onboarding normal;
- subnet reachability e conflito;
- binding explícito por adaptador;
- persistência de ID/MAC/IP local alvo;
- recusa de troca silenciosa de adaptador;
- health contínuo;
- latência e perda de pacotes;
- Guided Setup;
- recuperação segura após reinício.

Não existe código para bridge, ICS, hotspot ou NAT.

Pendente apenas a certificação nos PCs reais Industrial/Monte Castelo.

## A2 — Meter Engine

Entregue:

- smoothing attack/release;
- peak hold/decay;
- clip;
- stale detection;
- semantic meter state;
- WebSocket/HTTP LAN autenticado;
- backpressure `latest frame wins`;
- filas OSC limitadas/coalescidas;
- teste lógico equivalente a 1 hora, 32 canais, 30 fps.

Pendente: soak físico com mesa + browser/tablet + rede real.

## A3 — X32

Entregue:

- OSC/UDP 10023 com bind local;
- descoberta e `/xinfo`;
- 32 canais, buses, DCA, Main;
- meters;
- fader/mute/pan/bus send/routing;
- headamp source resolution;
- gain, phantom, EQ, gate, compressor e scene recall implementados;
- confirmação por read-back/estado observado;
- manifesto de certificação ligado a model/firmware/venue;
- deep controls não são anunciados antes da certificação física.

Pendente: executar o gate em Monte Castelo e preencher evidências reais.

## A4 — Mix UI

Entregue:

- Mix responsivo;
- selected-channel inspector;
- meters reais/stale;
- processing inspector;
- confirmação explícita para 48V e scenes;
- Health Center;
- Guided Setup;
- Soundcheck;
- Remote Mix admin;
- nenhum botão profundo aparece sem capability certificada.

## A5/A6 — Soundcraft Si

Entregue:

- `AudioConsoleProvider` neutro;
- manifest de capability/certificação;
- provider shell sem controles falsos;
- HiQnet UDP/TCP capture harness;
- Physical Spike wizard local;
- captura com hash/evidência/markers;
- zero-write guarantee durante reverse engineering;
- testes com portas efêmeras para evitar colisões no CI.

Pendente: sessão física no Industrial. Nenhum write desconhecido será enviado
antes de interpretação reproduzível + teste seguro.

## A7 — Signal Trace / Audio Doctor

Entregue:

- diagnóstico determinístico;
- evidência observada/inferida/desconhecida;
- Signal Trace;
- stale vs sem sinal;
- mute/fader/gate/compressor/routing/bus/output checks.

Pendente: validar thresholds/telemetria contra consoles físicas.

## A8 — Soundcheck + MusicScale

Entregue:

- Soundcheck interativo;
- peak/clip history;
- MusicScale scale context;
- participantes/funções da escala;
- mapping explícito pessoa/função → canal por venue;
- preferência por mapping individual sobre fallback de função;
- mudança de músico nunca altera gain/EQ/routing/phantom automaticamente.

## A9 — Remote Mix

Entregue:

- grants temporários e revogáveis;
- role/least privilege;
- relay protocol;
- Firebase identity;
- MillionsNest organization membership authorization;
- scope org + venue + LiveSystem + Node;
- Node outbound tunnel;
- nenhuma porta da mesa publicada;
- snapshot remoto;
- comandos remotos passam pelo mesmo safety/capability engine;
- meter adaptativo por RTT/visibilidade;
- browser Remote Mix;
- tela local para ativar relay, gerar link e revogar grants.

Pendente para produção externa:

- deploy do relay persistente com WSS;
- configurar URL pública do NestLive;
- teste real fora da LAN;
- auditoria de sessão real em operação.

## Produção

Web/PWA pode ser publicado quando CI estiver verde porque recursos físicos não
certificados permanecem fail-closed. Installer beta pode ser gerado pelo CI.

O selo **hardware-certified production** continua condicionado ao
`docs/certification/production-certification.json` e evidências físicas.

## Regra final

Código pronto não equivale a hardware certificado. Gates físicos continuam
obrigatórios e nunca serão marcados como concluídos artificialmente.
