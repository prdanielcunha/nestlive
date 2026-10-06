# NestLive Remote Mix

## Regra de segurança

A console **nunca** recebe exposição pública, port-forwarding ou token cloud.

Fluxo:

```text
browser remoto
  -> NestLive Cloud
  -> sessão temporária autenticada do NestLive Node
  -> binding LAN explícito
  -> mesa
```

## Entregue no núcleo

- grants com expiração máxima de 4 horas;
- bearer remoto salvo somente como hash;
- revogação imediata;
- permissões separadas para read, fader, mute, guarded e critical;
- política adaptativa de meters;
- contrato `RemoteMixRelay`;
- desligamento do meter quando a tela remota não está visível.

## Ainda depende do backend cloud

A implementação concreta do relay precisa do serviço NestLive Cloud e do auth MillionsNest. O Node está pronto para plugar o relay sem expor a console.

Nenhuma sessão remota deve ser marcada como pronta para produção antes de:

1. validar identidade MillionsNest;
2. validar organização + venue + LiveSystem;
3. aplicar permissões do grant;
4. auditar comandos;
5. testar revoke e expiração;
6. cortar internet e comprovar que o Mix LAN segue operando.
