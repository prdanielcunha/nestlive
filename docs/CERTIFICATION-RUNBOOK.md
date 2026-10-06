# NestLive — Runbook de certificação física 0.1

Este documento é um **gate**, não uma declaração de aprovação. Nenhum item recebe PASS sem evidência produzida no equipamento real.

## Monte Castelo — X32

Ambiente esperado:

- PC de produção com Ethernet mantendo a rede principal/internet;
- adaptador Wi-Fi USB dedicado à rede da X32;
- nenhuma Ponte de Rede, ICS, hotspot ou NAT;
- NestLive instalado pelo pacote candidato.

Executar e registrar:

1. instalação limpa e reinício do Windows;
2. NestLive inicia automaticamente;
3. Ethernet permanece com gateway principal;
4. Wi-Fi USB aparece como interface separada;
5. Guided Setup seleciona a interface da mesa sem alterar a rota da internet;
6. X32 é encontrada por discovery/read-only;
7. leitura de nomes, 32 canais, buses e DCA;
8. meters contínuos por pelo menos 60 minutos;
9. fader físico → UI;
10. fader UI → mesa → confirmação observada;
11. mute nos dois sentidos;
12. pan;
13. atribuição Main LR em leitura;
14. send canal → bus;
15. remover/reconectar Wi-Fi USB;
16. reiniciar NestLive;
17. desligar internet mantendo LAN da X32;
18. confirmar ausência de replay duplicado de comandos.

## Industrial — Soundcraft Si Expression

A certificação começa em modo de captura/read-only.

1. registrar modelo e firmware;
2. conectar o harness HiQnet;
3. capturar discovery e estado sem escrita;
4. mapear cada capability com evidência;
5. marcar unsupported quando a mesa/protocolo não fornecer a função;
6. somente depois liberar escrita, uma capability por vez;
7. fader/mute antes de qualquer ação crítica;
8. phantom/scene recall nunca são habilitados por suposição;
9. repetir queda/reconexão e teste sem internet.

O manifesto de Soundcraft deve sair sem itens `untested` antes do provider ser promovido de laboratório.

## Produção visual

Certificar separadamente:

- Holyrics no PC de projeção;
- Resolume Arena em outro PC, recebendo o fluxo de mídia existente;
- ProPresenter em cenário próprio;
- falha de um provider não derruba os demais;
- Live Node reiniciado não repete comandos já concluídos.

## Dispositivos e UX

Executar:

- Windows + iPad;
- Windows + Android;
- desktop responsivo;
- tablet landscape;
- celular;
- voluntário sem treinamento seguindo apenas Guided Setup;
- navegação por teclado e leitores/contraste onde aplicável.

## Performance

Registrar no manifesto:

- p95 comando → estado observado < 300 ms no LAN;
- 1 hora de meters sem travamento;
- stress com todos os canais visíveis;
- perda/reconexão sem congelar estado como se fosse sinal válido.

## Assinatura

Antes da promoção comercial:

- Windows: Authenticode válido no executável e instalador;
- macOS: Developer ID + notarização + staple;
- hashes SHA-256 publicados;
- branch protection ativa.

## Evidência

Cada item deve apontar para um artefato verificável: relatório, log, vídeo do teste, hash/release, captura do certificado ou ticket de certificação. O arquivo `production-certification.json` permanece PENDING até isso existir.
