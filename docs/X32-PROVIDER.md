# NestLive — Behringer X32 Provider

## Estado

Implementação de software: **funcional por contrato**  
Certificação física Monte Castelo: **pendente**

## Transporte

- OSC sobre UDP;
- porta padrão 10023;
- bind explícito no endereço local da interface dedicada;
- `/xinfo` para probe;
- `/xremote` para reconciliação de mudanças físicas;
- escrita por float/int e confirmação posterior por leitura;
- meters locais por `/meters`, renovados antes do timeout.

## Descoberta sem digitar IP

O caminho normal pode varrer **somente a subnet local selecionada** e enviar uma consulta
read-only `/xinfo` para os hosts candidatos. A descoberta:

- é limitada a no máximo 512 hosts;
- usa a interface de áudio explicitamente escolhida;
- não altera nenhuma configuração da mesa;
- ignora tráfego UDP que não seja uma resposta `/xinfo`;
- retorna endereço, nome, modelo e firmware encontrados.

Isso remove a necessidade de IP manual no fluxo normal sem usar broadcast global ou bridge entre redes.

## Capabilities expostas nesta etapa

- estado da console;
- channels;
- buses;
- DCA/groups;
- meters;
- fader;
- mute;
- pan;
- state reconciliation por `/xremote`.

Gain, phantom, EQ, gate, compressor, routing e scene recall **não são anunciados ainda**. Eles entram somente após implementação e validação segura, mantendo a regra “nenhum botão falso”.

## Meter mapping

- `/meters/1`: entradas + reduções de gate/dynamics;
- `/meters/2`: buses/matrix/main;
- valores lineares são convertidos para dBFS no adapter;
- valores `>= 1.0` são tratados como clip.

## Gate físico obrigatório

Em Monte Castelo:

1. Ethernet permanece como internet;
2. Wi-Fi USB entra na rede da X32;
3. NestLive fixa o provider no Wi-Fi USB;
4. descoberta read-only encontra a mesa;
5. `/xinfo` responde;
6. 32 canais são lidos;
7. meter flui por 1 hora;
8. fader físico atualiza o estado;
9. fader NestLive altera a mesa e é confirmado;
10. mute nos dois sentidos;
11. queda/reconexão do Wi-Fi;
12. reinício do Node;
13. internet desligada sem perda do controle LAN.

Enquanto esse gate não passar, o provider é **beta de laboratório**, não “certificado”.
