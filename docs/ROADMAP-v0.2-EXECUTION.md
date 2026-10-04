# Roadmap v0.2 — execução no NestLive

**Início:** 04/10/2026

| Fase | Estado | Situação |
|---|---|---|
| A0 — contratos de áudio e multi-rede | **implementado em fundação** | contratos, safety, meters e simulador |
| A1 — Multi-network Node | **iniciado** | enumeração, subnet conflict, candidatos e binding explícito |
| A2 — Meter Engine | **iniciado** | smoothing, peak hold, clip e stale detection |
| A3 — X32 | próxima | provider real + teste físico |
| A4 — Mix UI premium | planejada | desktop/tablet/mobile |
| A5 — Soundcraft physical spike | depende de hardware | capabilities reais |
| A6 — Soundcraft production provider | bloqueada por A5 | — |
| A7 — Signal Trace + Audio Doctor | planejada | — |
| A8 — Soundcheck + contexto da escala | planejada | — |
| A9 — Remote Mix | planejada | — |

## A0 — gate técnico

A fundação agora possui:

- domínio neutro, sem marca;
- capability set de áudio;
- safety por capability;
- `MeterFrame`;
- `NetworkInterface`;
- `ProviderNetworkBinding`;
- console simulada com meters e state patches;
- testes de contrato.

A0 ainda precisa passar no CI da branch antes de ser marcado como fechado.

## A1 — o que já existe

- enumeração das interfaces do sistema operacional;
- classificação Ethernet / Wi‑Fi / USB Wi‑Fi / virtual;
- cálculo de alcance por subnet;
- detecção inicial de conflito entre sub-redes;
- seleção de candidatos para alcançar a mesa;
- criação de binding explícito sem mudar rede do Windows.

Ainda faltam: gateways/metric, health ativo, persistência após reboot, detecção de troca de adaptador e wizard.

## A2 — o que já existe

- attack/release visual;
- peak hold;
- peak decay;
- clip;
- semantic meter state;
- stale detection separada de “sem sinal”.

Ainda faltam: WebSocket LAN, backpressure/rate limiting, prioridade de comandos e stress test com muitos canais.

## Regra de migração

O código comprovado do repositório anterior será portado seletivamente. Firebase/hosting, certificados, releases e certificações antigas não serão herdados automaticamente pelo NestLive.
