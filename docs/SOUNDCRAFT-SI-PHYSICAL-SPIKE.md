# Soundcraft Si Expression — Physical Spike do NestLive

**Venue:** Industrial  
**Objetivo:** descobrir e comprovar capabilities reais antes de liberar qualquer controle no produto.

## Fatos de integração já tratados

A Si Expression usa a porta Ethernet **HiQnet** para controle remoto. O fluxo conhecido exige rede local na mesma subnet e broadcast habilitado. O console pode iniciar uma conexão TCP de volta ao controlador após descoberta UDP.

NestLive não assume que todas as funções da ViSi Remote são automaticamente seguras ou documentadas para uso próprio.

## Regra de produção

A6 não ganha capabilities por expectativa.

Cada capability do manifesto começa como:

`untested`

e só muda para:

- `read_only`;
- `read_write`;
- `unsupported`;

depois de teste físico documentado.

A UI consome **somente** o conjunto certificado.

## Harness incluído

`HiqnetCaptureHarness`:

- escuta UDP/TCP na porta 3804;
- pode fixar o bind no IP do Wi-Fi USB;
- registra origem, tamanho e prefixo hexadecimal;
- não envia writes desconhecidos;
- serve para comprovar se o console está chegando ao NestLive Node.

## Procedimento no Industrial

1. Manter Ethernet conectada à internet.
2. Conectar Wi-Fi USB ao roteador dedicado da Soundcraft.
3. Não habilitar Bridge, ICS, hotspot ou NAT.
4. Abrir o spike no endereço do Wi-Fi USB.
5. Confirmar ping/reachability da mesa.
6. Abrir ViSi Remote separadamente, quando útil para comparação.
7. Registrar discovery UDP e conexão TCP.
8. Validar leitura do modelo/estado.
9. Validar canais e nomes.
10. Validar meters.
11. Somente depois testar uma escrita pequena em canal reservado.
12. Registrar valor anterior.
13. Aplicar mudança.
14. Confirmar fisicamente/telemetria.
15. Restaurar valor anterior.
16. Testar reconnect.
17. Testar alteração física simultânea.
18. Testar 1 hora de telemetria.
19. Classificar cada capability.
20. Salvar evidências no relatório de certificação.

## Proibição

Não transformar packet capture desconhecido em controle de produção sem:

- interpretação reproduzível;
- teste de leitura;
- teste de escrita em canal não crítico;
- restauração;
- comportamento de erro conhecido.

Isso preserva a regra do roadmap: **nenhum botão falso**.
