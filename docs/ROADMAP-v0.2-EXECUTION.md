# Roadmap v0.2 — execução no NestLive

**Início:** 04/10/2026

| Fase | Estado de software | Certificação física |
|---|---|---|
| A0 — contratos de áudio e multi-rede | **implementado** | n/a |
| A1 — Multi-network Node | **fundação implementada** | pendente nos PCs reais |
| A2 — Meter Engine | **fundação implementada** | pendente stress/hardware |
| A3 — X32 | **provider OSC implementado** | pendente Monte Castelo |
| A4 — Mix UI premium | em implementação | — |
| A5 — Soundcraft physical spike | harness a implementar | pendente Industrial |
| A6 — Soundcraft production provider | bloqueado por A5 | pendente |
| A7 — Signal Trace + Audio Doctor | **núcleo determinístico implementado** | validar com telemetria real |
| A8 — Soundcheck + Scale Context | **modelo de Soundcheck implementado** | integração UI/escala pendente |
| A9 — Remote Mix | **policy/adaptive meters implementados** | relay/auth final pendente |

## A0

Entregue:

- domínio neutro;
- capability set;
- safety;
- `MeterFrame`;
- `NetworkInterface`;
- `ProviderNetworkBinding`;
- simulador;
- testes.

## A1

Entregue em software:

- enumeração de interfaces;
- classificação Ethernet / Wi-Fi / USB Wi-Fi / virtual;
- subnet reachability;
- detecção de subnet conflict;
- binding explícito;
- persistência atômica de bindings;
- health classification;
- recuperação segura quando adaptador some.

Não há código que habilite bridge, ICS ou NAT.

Pendente para certificação: descobrir gateway/metric de forma específica por OS, medir perda/latência real e executar o Guided Setup nos PCs Industrial/Monte Castelo.

## A2

Entregue:

- smoothing attack/release;
- peak hold/decay;
- clip;
- stale detection;
- semantic meter state;
- WebSocket LAN autenticado;
- rate gate;
- backpressure “latest frame wins” para nunca bloquear comandos.

Pendente: stress test real com console e browser/tablet.

## A3

Implementado:

- OSC codec;
- UDP 10023 com bind local;
- `/xinfo`;
- 32 canais;
- buses;
- DCA;
- fader/mute/pan com confirmação observada;
- subscriptions `/meters/1` e `/meters/2`;
- conversão de meter linear para dBFS.

Não anunciamos gain/phantom/EQ/dynamics/routing/scenes até implementar e certificar cada capability.

## A7–A9

Já existem núcleos de:

- diagnóstico determinístico;
- Signal Trace com evidência observada/inferida;
- Soundcheck state + peak/clip history;
- Remote Mix grants e taxa adaptativa de meters.

## Regra

Código pronto não equivale a hardware certificado. Gates físicos continuam obrigatórios e não serão marcados como concluídos artificialmente.
