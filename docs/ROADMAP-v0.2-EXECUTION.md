# Roadmap v0.2 — execução no NestLive

**Início:** 04/10/2026

| Fase | Estado | Situação |
|---|---|---|
| A0 — contratos de áudio e multi-rede | **em implementação** | contratos, safety, meters e simulador |
| A1 — Multi-network Node | próxima | Ethernet + Wi-Fi USB, binding explícito |
| A2 — Meter Engine | próxima | smoothing, peak hold, clip, stale |
| A3 — X32 | próxima | provider real + teste físico |
| A4 — Mix UI premium | planejada | desktop/tablet/mobile |
| A5 — Soundcraft physical spike | depende de hardware | capabilities reais |
| A6 — Soundcraft production provider | bloqueada por A5 | — |
| A7 — Signal Trace + Audio Doctor | planejada | — |
| A8 — Soundcheck + contexto da escala | planejada | — |
| A9 — Remote Mix | planejada | — |

## Gate A0

A0 fecha somente quando:

- o domínio não contém lógica específica de X32/Soundcraft;
- dois adapters podem implementar o mesmo contrato;
- o simulador gera meters e state patches;
- capabilities inexistentes não aparecem;
- safety classifica ações perigosas;
- `live_mix` permanece controlado por feature flag.

## Regra de migração

O código comprovado do repositório anterior será portado seletivamente. Firebase/hosting, certificados, releases e certificações antigas não serão herdados automaticamente pelo NestLive.
