# Cambé operação local e desempenho

O NestLive já contém o engine de produção portado do MusicScale Live. No computador que usa NestLive como central, iniciar somente NestLiveService.exe. Ele abre AudioNode e ProductionNode internamente. Esses três processos são esperados: mantêm o áudio separado da produção. Um MusicScaleLiveNode independente no mesmo PC duplica a parte de produção e pode ocupar a porta do gateway.

Pastas separadas para programas instalados são normais e não geram carga de CPU por si. Não juntar, mover ou apagar as pastas. Não copiar automaticamente credenciais ou configurações entre produtos. Esta atualização não desinstala nem encerra o outro produto: se detectar as portas ocupadas, informa o conflito antes de iniciar os filhos. O operador escolhe a central e fecha a outra pelo próprio aplicativo ou processo identificado.

## Ativar em Cambé

1. Antes do culto, deixe uma única central no PC. Para usar os streams de áudio, medidores e produção integrados, abra NestLiveService.exe. Holyrics e Resolume continuam abertos normalmente, inclusive em PCs diferentes se essa é a instalação usada.
2. No mesmo PC, abra http://127.0.0.1:4317/local. Este é o painel NestLive. O painel MusicScale independente usa /node; não misture os pareamentos dos dois produtos.
3. Mantenha o PC na OBPC com internet e conecte o Wi-Fi USB ao roteador dedicado da X32. O celular permanece na OBPC. Não crie ponte de rede ou ICS. As redes precisam ter caminhos sem ambiguidade; duas sub-redes sobrepostas impedem o aceite.
4. Escaneie o QR NestLive, conclua o pareamento com o PIN exibido no PC e abra Configuração. Use Já fiz — verificar e Procurar mesa. A descoberta X32 usa somente a subnet da interface dedicada e uma consulta de identificação, sem alterar o áudio. Aguarde até dez segundos após trocar uma conexão de rede para atualizar o inventário compartilhado.
5. Escolha a X32 encontrada e conecte. Confira modelo, firmware e nomes dos canais reais. Em caso de falha, leia o IP e a máscara em Setup > Network da X32 e confira a interface do PC. Não utilizar os dados da Soundcraft do Industrial.
6. Abra Mix. Confira se os medidores recebem sinal real e se mover um fader físico aparece no celular. Em canal sem uso, teste um pequeno ajuste e mute, confirme a leitura de volta e restaure os valores.
7. Para operar Holyrics/Arena, use Abrir painel de produção no console local ou /production/. Preserve a ligação HDMI/captura existente e os Nodes dos outros PCs necessários à topologia. Conectar a X32 não configura automaticamente as APIs Holyrics/Arena.

## Alterações de consumo

- Um bloqueio de supervisor impede outro NestLive de iniciar seus motores em paralelo. O serviço verifica também as portas gateway e produção antes de iniciar, sem matar processos desconhecidos.
- A inspeção Windows de interfaces, feita por PowerShell, é compartilhada entre chamadas e mantida por dez segundos. Requisições simultâneas aguardam a mesma inspeção, evitando um PowerShell por celular, diagnóstico e recarga do console. O cache não contém valores de áudio e não reduz a frequência dos medidores.
- O console reutiliza seu QR e deixa de recarregar integralmente a cada dois segundos. Atualiza a cada cinco segundos enquanto visível, e ao voltar à tela.
- Observações idênticas de providers não são gravadas de novo em disco nem alteram a revisão do estado. Mudanças reais continuam persistidas para recuperação.
- Holyrics é observado a cada 1,2 s. Arena mantém o WebSocket e consulta de reconciliação a cada 1,5 s. A detecção de Arena ausente recua para até 60 s entre tentativas e registra a transição, sem repetir o mesmo log.
- O motor da X32 mantém os streams de estado e meters, interface dedicada, filas limitadas e confirmação de escrita existentes. A otimização das consultas de apresentação não muda a cadência do transporte de áudio.

O objetivo é menor trabalho redundante. CPU, memória, disco e latência reais dependem do PC, da rede, da mesa e da composição do Arena. Não há medição física de desempenho de Cambé nesta alteração. Verificar no Gerenciador de Tarefas com o repertório e a composição reais antes do culto; uma janela de console aberta não prova consumo alto.

## Limites de liberação

Fader, mute, pan e medidores existem no provider X32. Controles profundos dependem das capabilities efetivamente anunciadas e da certificação física vinculada ao equipamento. Não forjar certificado, habilitar ganho/48V ou recall por uma flag para completar a tela. O controle físico da mesa permanece disponível.

Os testes de software não certificam X32, roteador ou PC da igreja. O teste local de um canal livre ainda precisa ser concluído pelo operador.

## Fontes

- Node processos e execução em segundo plano: https://nodejs.org/api/child_process.html
- Streams e limites de fila HTTP: https://nodejs.org/api/http.html
- Implementação/documentação X32 de Patrick-Gilles Maillot: https://github.com/pmaillot/X32-Behringer
