# Conveyer LTX: teste de uma cena

Página local: `/tools/ltx-scene-test`. **Preparar sem cobrança** normaliza a imagem
para 1920×1080 e exporta o JSON usado nas rodadas 5/6: NVFP4, 145 frames, 24 fps,
duas etapas, Sol-Attn apenas na segunda, decodificação de áudio conectada à saída.
Não faz chamadas de rede externas. Os cinco checkpoints e seus SHA-256 estão em
`src/lib/services/ltx/models.json`. ComfyUI fixado em
`3f767e7f67bc587e88d6de6668eb424f725d4649` (0.37.1).

O adaptador `animateLtxScene` envia a imagem, faz **um único** POST `/prompt`,
consulta o histórico e salva o MP4. Consome a autorização em disco antes do envio.
Se a resposta for perdida, não repete nem muda de provedor. Confirma a parada do
Pod antes do corte local para 1080p e remoção de áudio da cópia destinada à
narração. Mantém o original com áudio. Não altera vídeos existentes.

## Ativação paga: exclusivamente após autorização explícita

Esta integração **não cria/inicia Pods**. A preparação do ambiente e a criação
continuam sendo responsabilidade do controlador de rodada, que deve estar armado
**antes** da primeira chamada paga. O guardian abaixo adiciona uma proteção à
geração iniciada pela aplicação; não substitui essa proteção do provisionamento.

1. Confirmar limite de US$ 2, uma cena, prazo de 90 minutos; aplicar parada
   antecipada de 65 minutos contando **desde antes da criação do Pod**.
2. Usar somente o Pod novo da rodada, Secure, PRO 4500 Blackwell, cotação no
   máximo US$ 0,72/h. Confirmar CUDA/Torch/Sage/NVFP4, hashes dos checkpoints e
   ComfyUI com o pacote validado. Não reutilizar autorizações de rodadas anteriores.
3. Abrir túnel SSH privado para ComfyUI em `127.0.0.1:<porta-local>`.
4. Criar um lease sem credenciais com `approvalId`, `podId`, `podName`,
   `comfyUrl`, `startedAt`, `deadline` (ambos epoch **milissegundos**),
   `budgetUsd: 2`. Nome do Pod começa por `conveyer-ltx-`.
   O prazo absoluto deve ser o do controlador original, sem reiniciar o relógio.
5. Iniciar `guardian.py` como processo independente, com `RUNPOD_API_KEY`
   herdado somente no ambiente, `--lease <arquivo>` e
   `--session-dir <DATA_DIR>/ltx-session`. Ele acrescenta `guardianPid`, grava
   `session.json` e atualiza `armed.json`. Nunca envia a chave em URL nem a salva.
   Se houver sessão anterior, arquivá-la apenas depois de confirmar sua GPU parada.
6. Verificar a identidade, PID, prazo e heartbeat antes da geração. A página
   libera uma confirmação explícita de pagamento e uma única geração. Resultados
   ficam em `<DATA_DIR>/ltx-tests/<approvalId>/`.
7. A aplicação e o guardian podem solicitar STOP; ambos verificam identidade.
   O guardian não cria, reinicia ou exclui recursos. A aplicação só mostra sucesso
   após observar EXITED/TERMINATED. Falta de confirmação gera alerta de parada.

O Mac precisa permanecer ligado e conectado. O controlador anterior à criação
permanece necessário, inclusive se a instalação demorar ou a aplicação fechar.
Não habilitado para vídeos inteiros nem para o fallback automático de `img2vid`.
O transporte Serverless existente permanece separado. 4090/int8 não foi validado
nestes testes; não é escolhido automaticamente.

## Verificação gratuita

Testes do adaptador usam transporte falso e arquivos temporários, verificando
envio único, autorização, prazo, saída, parada e falhas. Não criam GPU. A tela de
preparação funciona sem lease e mantém o botão pago bloqueado. Um teste ao vivo
via Conveyer ainda exige a rodada explicitamente autorizada acima.

## Integração com cenas do Conveyer

O seletor de IA inclui `ltx`. A primeira execução e o Resume passam por `visual-source.ts`, que prepara `ltx/beat_XXXX/request.json` e pausa o run se a imagem ou o clipe ainda não estiver pronto. O estado de pausa usa o mecanismo existente de cancelamento retomável. Não chama outro fornecedor nem cria GPUs.

Em `/tools/ltx-scene-test`, a fila mostra as cenas e o vídeo correspondente. Para imagens, Preparar salva a imagem localmente; para vídeos, prepara o quadro inicial e só permite um envio quando houver uma sessão aprovada, com guardian independente. O `request.lock` continua compartilhado por autorização. Depois do download e da parada confirmada, o clipe silencioso é aplicado à cena; o original com áudio fica no diretório da geração. Uma recuperação da aplicação local não faz outro envio.

O hash da descrição, mídia, duração e resolução impede aplicar um clipe a uma cena alterada. Resume mantém narração, planejamento e clipes existentes. A montagem ajusta o clipe fixo de 6,04 s à duração do beat; uma duração maior repete o clipe. O perfil validado é NVFP4 em RTX 5090/PRO 4500; 4090/int8 e geração em lote continuam sem validação/autorização.

Selecionar LTX não autoriza iniciar GPU. Narração, planejamento e outros serviços do vídeo mantêm seus próprios custos. Não mudar `.env.local`, não publicar e não iniciar novo recurso sem aprovação explícita.
