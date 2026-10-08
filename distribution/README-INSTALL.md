# NestLive — pacote de instalação

O usuário instala **NestLive** uma vez. Internamente o runtime é separado em processos especializados, mas isso fica invisível no fluxo normal:

- `NestLiveService` — supervisor;
- `NestLiveAudioNode` — áudio, rede, pairing e gateway local;
- `NestLiveProductionNode` — Holyrics, Resolume, ProPresenter e providers de produção.

O navegador/tablet fala somente com o gateway local na porta **4317**. O engine de produção fica restrito a `127.0.0.1:4337`.

## Windows

Abra `NestLiveSetup.exe`.

O instalador:

1. copia os três executáveis e a PWA local;
2. inicia somente `NestLiveService.exe`;
3. registra início automático no login;
4. libera TCP 4317 e UDP 4318 apenas para perfil de rede privada;
5. não libera a porta interna 4337;
6. abre `http://127.0.0.1:4317/local`.

Não exige Git, PowerShell, IP ou porta no fluxo normal.

## macOS

Execute `install.command` no pacote de laboratório. O canal comercial deverá usar `.pkg` assinado/notarizado.

## Linux

Execute:

```bash
./install.sh
```

Quando systemd user está disponível, o instalador cria `nestlive.service`.

## Segurança

- produção profunda não é exposta diretamente na LAN;
- o gateway autentica o dispositivo pareado antes do proxy interno;
- um segredo efêmero diferente é usado entre gateway e engine de produção a cada início do supervisor;
- credenciais de providers continuam locais;
- nenhuma bridge, ICS, hotspot ou NAT é criada;
- internet não é requisito para o caminho LAN do culto.

## Certificação

Um pacote gerado pelo CI é **beta técnico** até passar pelos gates físicos de X32, Soundcraft, Holyrics, Resolume, ProPresenter, queda de internet, reinício e testes de voluntário.

## Download rápido

A distribuição beta Windows é publicada como **pré-lançamento** em
https://github.com/prdanielcunha/nestlive/releases após aprovação do
pipeline de empacotamento no `main`.

Se houver atraso na publicação do release, o último artefato de teste
Windows está disponível (com login GitHub) em:
https://github.com/prdanielcunha/nestlive/actions/runs/37521838561

O instalador beta **não é uma certificação do equipamento**.
É preciso testar localmente antes de usar comandos de áudio num culto.
