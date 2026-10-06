# NestLive — Meter Engine stress contract

A validação automatizada executa o equivalente lógico de **1 hora** com:

- 32 canais;
- 30 frames por segundo;
- 108.000 frames;
- smoothing/peak/clip ativos;
- consumidor visual propositalmente mais lento que a origem;
- buffer `latest frame wins`.

O objetivo é provar que telemetria intermediária pode ser descartada sem crescer uma fila ilimitada e sem bloquear o caminho de comando.

Este teste é **complementar**, não substitui o gate físico de 1 hora com X32/Soundcraft, browser e rede reais.
