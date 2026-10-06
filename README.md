# NestLive

**NestLive** é o módulo de operação e orquestração de cultos da MillionsNest.

O repositório oficial é `prdanielcunha/nestlive` e o nome do módulo é **NestLive**.

## Princípios

- LAN-first;
- provider-agnostic;
- offline-capable;
- capability-driven;
- state-is-truth;
- zero hardware adicional obrigatório no caminho principal;
- zero API paga obrigatória para operação local;
- PT / EN / ES desde o início.

## Roadmap em execução

A implementação começou pela **FASE A0 — contratos de áudio e multi-rede** do Roadmap v0.2.

Nesta primeira entrega entram:

- `AudioConsoleProvider` neutro;
- `AudioCapabilitySet`;
- `MeterFrame`;
- contratos de canais, buses, groups e routing;
- níveis de safety;
- `NetworkInterface`;
- `ProviderNetworkBinding`;
- feature flag `live_mix`;
- provider de áudio simulado para provar o contrato sem depender de hardware.

A base madura de `musicscale-live` será portada de forma controlada depois que os contratos NestLive estiverem estáveis. Nenhuma configuração de produção antiga será copiada automaticamente.

## Estrutura

```text
packages/domain                contratos neutros do NestLive
packages/adapters-audio-sim    console simulada para A0/A2
docs/                          decisões e execução do roadmap
```

## Comandos

```bash
npm install
npm run typecheck
npm test
```

> `live_mix` permanece desligado por padrão enquanto os gates A0–A3 não forem validados.
