# ADR-0001 — NestLive é o nome canônico

**Status:** aceito  
**Data:** 2026-10-04

## Decisão

O produto/módulo passa a se chamar **NestLive**.

O repositório canônico passa a ser:

`prdanielcunha/nestlive`

Pacotes internos usam o namespace `@millionsnest/nestlive-*`.

## Consequência

A implementação anterior de `musicscale-live` deixa de ser a origem de novas decisões de domínio. Funcionalidades maduras poderão ser portadas, mas deverão respeitar os contratos neutros do NestLive.

A renomeação não elimina a integração com o MusicScale: escala, repertório, identidade, organização, permissões e assinatura continuam integrações de primeira classe.
