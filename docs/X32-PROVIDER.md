# NestLive — Behringer X32 Provider

## Estado

Implementação de software: **iniciada / funcional por contrato**  
Certificação física Monte Castelo: **pendente**

## Transporte

- OSC sobre UDP;
- porta padrão 10023;
- bind opcional no endereço local da interface dedicada;
- `/xinfo` para probe;
- leitura por query sem argumento;
- escrita por float/int e confirmação posterior por leitura;
- meters locais por `/meters`, renovados antes do timeout.

## Capabilities expostas nesta etapa

- estado da console;
- channels;
- buses;
- DCA/groups;
- meters;
- fader;
- mute;
- pan.

Gain, phantom, EQ, gate, compressor, routing e scene recall **não são anunciados ainda**. Eles entram somente após implementação e validação segura, mantendo a regra “nenhum botão falso”.

## Meter mapping

- `/meters/1`: 32 entradas + 32 gate reductions + 32 dynamics reductions;
- `/meters/2`: buses/matrix/main;
- valores lineares são convertidos para dBFS no adapter;
- valores `>= 1.0` são tratados como clip.

## Gate físico obrigatório

Em Monte Castelo:

1. Ethernet permanece como internet;
2. Wi-Fi USB entra na rede da X32;
3. NestLive fixa o provider no Wi-Fi USB;
4. `/xinfo` responde;
5. 32 canais são lidos;
6. meter flui por 1 hora;
7. fader físico atualiza o estado;
8. fader NestLive altera a mesa e é confirmado;
9. mute nos dois sentidos;
10. queda/reconexão do Wi-Fi;
11. reinício do Node;
12. internet desligada sem perda do controle LAN.

Enquanto esse gate não passar, o provider é **beta de laboratório**, não “certificado”.
