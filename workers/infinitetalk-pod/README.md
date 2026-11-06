# Conveyer InfiniteTalk: rodada de teste (avatar via GPU alugada)

Separado de propósito de `workers/ltx-pod` — nunca compartilha ambiente, pesos
ou identidade de rodada com o LTX. Teste de viabilidade: imagem de referência
do Finn (já salva no canal) + 10,14s recortados da narração existente, gerando
um clipe curto via InfiniteTalk (MeiGen-AI, commit
`50aa0a94184315407a991ae804d9b58d6d311ba8`).

Nada aqui cria ou inicia Pod sozinho — isso continua sendo responsabilidade do
controlador da rodada, armado **antes** da primeira chamada paga, com guardian
independente (mesmo padrão de `workers/ltx-pod/guardian.py`, nome de Pod
próprio — nunca reaproveita identidade/autorização de rodada anterior).

## O que foi corrigido em relação ao README oficial

Medido antes de autorizar a rodada (ver CLAUDE.md do projeto principal se
existir uma seção equivalente, ou o histórico da conversa que gerou isto):

1. **`flash-attn` via wheel pré-compilado**, não `pip install flash_attn==2.7.4.post1`
   (que compila do zero, 20-45+ min). O wheel oficial do Dao-AILab pra
   cu12/torch2.4/cp310 reduz isso pra ~1-2 min.
2. **InfiniteTalk baixa só `single/infinitetalk.safetensors` (9,95 GB)**, via
   `--include`, em vez do repositório inteiro (168,5 GB — inclui variantes
   multi/comfyui/fp8/int8/lora que este teste de uma imagem não usa).

Sem essas duas correções, a instalação sozinha arrisca estourar os 65-90 min
autorizados. Com elas, a estimativa é ~20-35 min de instalação, sobrando
margem real pra gerar o clipe.

## Arquivos

- `install.sh` — instalação completa (clone fixado no commit, venv Python 3.10,
  torch 2.4.1/cu121, xformers, flash-attn via wheel, deps, pesos seletivos).
  Cada etapa loga timestamp + tempo decorrido. Falha alto (`set -euo pipefail`)
  em vez de continuar silenciosamente com GPU já sendo cobrada.
- `run_test.sh` — roda a geração única com os insumos já preparados (imagem do
  Finn + áudio de teste), modo `clip` (não `streaming` — é um clipe curto),
  `--num_persistent_param_in_dit 0` (baixa VRAM — uma RTX 4090 de 24GB é
  apertada pra esse modelo de 14B sem isso; um OOM aqui desperdiçaria a rodada).

## Entradas do teste

Lidas de `/Users/guilhermearaki/Documents/Codex/2026-10-05/continue-o-projeto-conveyer-runpod-ltx/outputs/infinitetalk-teste/`
(finn-referencia.jpg, narracao-teste.wav, entrada-infinitetalk.json) — hashes
já conferidos contra os valores registrados em `proposta-teste.json` e contra a
imagem real do canal Finn antes desta rodada.

## Ainda não existe aqui (próximo passo, não incluído ainda)

- O round-controller que efetivamente cria o Pod via API Runpod.
- O guardian adaptado (nome de Pod próprio, ex. `conveyer-it-*`).
- O túnel SSH e a montagem do lease, espelhando `services/ltx/session.ts`.

Nenhum Pod é criado, nenhuma cobrança acontece, só com esses dois scripts.
