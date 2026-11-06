# Imagens do ChatGPT por cena no Conveyer

A integração local está em `/tools/ltx-scene-test`, para cenas preparadas com o fornecedor LTX. Não muda o fornecedor selecionado, não inicia GPU e não gera imagens automaticamente ao criar ou retomar um vídeo.

## Uso

1. Escolher uma cena pendente do vídeo na fila LTX.
2. Conferir a descrição da imagem, derivada do roteiro. Preparar o prompt acrescenta o estilo amador curto aprovado, sem chamar o Codex.
3. Conferir o prompt completo. Marcar a autorização individual e clicar em Gerar uma imagem consome os limites da assinatura ChatGPT.
4. Conferir a prévia. Usar esta imagem na cena salva a entrada local; cenas de imagem ficam disponíveis para Retomar. Para vídeo, Preparar sem cobrança monta o fluxo LTX.
5. Animar no LTX exige outra autorização e uma sessão GPU com parada verificada. O gerador de imagens não cria ou inicia essa sessão.

## Importar vídeo do Colab ou Kaggle

Na mesma página, selecione uma cena de vídeo pendente, escolha o MP4 baixado do
notebook e clique em **Importar MP4 para esta cena**. A importação valida o arquivo
com ffprobe e FFmpeg, aceita até 256 MB e 120 segundos, e não inicia GPU nem gera
cobrança. Se a cena já tiver clipe, marque a confirmação explícita para substituí-lo.
Depois de importar, use **Resume run** na página do vídeo; para um roteiro salvo,
continue a montagem na página do roteiro. O arquivo importado fica associado à
identidade/fingerprint da cena e será invalidado se o planejamento da cena mudar.

Não há geração em lote, compra de créditos adicionais, troca para API com chave ou repetição automática. Prompts alterados recebem um novo registro e precisam de nova autorização. A mesma cena, prompt e controlador recuperam o registro já existente.

## Proteções

- Consentimento individual vinculado à cena, descrição, estilo e modelo. Travas persistentes impedem cliques duplicados e novos envios após reinício.
- Registro da thread antes do único turn/start. Recuperar resultado usa thread/read e nunca envia outro prompt.
- Apenas geração de imagem habilitada na thread; ferramentas externas e solicitações inesperadas são recusadas.
- Conta em pasta exclusiva; chaves de API removidas do ambiente. Não copia credenciais nem altera login.
- PNG real validado em 16:9, mínimo 256 px por lado, limite 40 MB / 40 milhões de pixels, SHA-256 e salvamento atômico. Caminhos reais precisam ficar dentro de generated_images.
- Aplicação verifica se a cena ainda existe e tem a mesma identidade. Falhas preservam a imagem original para reaplicação local.
- Cenas antigas continuam válidas; a nova descrição de imagem é metadado e não invalida clipes já preparados.

A conta padrão desta instalação foi autenticada separadamente em `~/Documents/Codex/conveyer-private/codex-images/account`, com uma pasta de trabalho vazia ao lado. O controlador padrão é gpt-6-luna, já validado em dois testes avulsos autorizados. O item retornado não identificou o modelo que desenhou; não rotular automaticamente como GPT Image 2.

Overrides locais opcionais: CONVEYER_CODEX_IMAGE_HOME, CONVEYER_CODEX_IMAGE_WORKSPACE, CONVEYER_CODEX_EXECUTABLE e CONVEYER_CODEX_CONTROLLER. Nenhum arquivo .env foi alterado. A instalação padrão assume este Mac com o aplicativo oficial instalado; outras máquinas precisam configurar o executável e autenticar sua própria pasta exclusiva.

## Recuperação e limites

Threads são persistentes (ephemeral=false) para permitir recuperação. Não há exclusão automática antes de confirmar a imagem salva. Se o processo ou o computador cair, o registro e a autorização consumida permanecem; usar Recuperar resultado. Uma trava da conta deixada por um processo interrompido requer diagnóstico antes de ser removida.

A seleção da cena permite reencontrar a imagem após atualizar a página neste navegador. O resultado também permanece em DATA_DIR/codex-images/jobs e pode ser reencontrado preparando exatamente o mesmo prompt. Retomar reutiliza imagens e clipes aplicados.

A integração continua controlada por cena. A narração, o planejamento e outros fornecedores do vídeo mantêm seus próprios limites/custos. A geração real da imagem e a animação LTX da cena de teste do liquidificador foram validadas pela interface, com autorizações individuais.

## Entrada de roteiro (2026-10-07)

`/tools/ltx-script` prepara cenas localmente, por frases, sem consulta a modelo.
O operador revisa descrição e movimento e salva um rascunho imutável em
`DATA_DIR/ltx-script-drafts`. Nenhuma linha de `runs` ou pipeline Studio é iniciada.
Essas cenas aparecem na fila LTX e usam os mesmos controles individuais de imagem,
recuperação, aplicação e autorização de GPU. As descrições começam com a narração
original; precisam de revisão visual. Ainda não há planejamento semântico por modelo,
geração em lote ou narração desses rascunhos.

## Montagem local dos rascunhos (2026-10-07)

Os roteiros salvos aparecem em `/tools/ltx-script`. Abrir um roteiro mostra o
progresso de cada cena e permite montar os clipes em ordem quando todos estão
prontos. O botão de continuação na tela de teste também abre esse roteiro, em vez
de tentar abrir um registro inexistente do fluxo Studio.

`Montar clipes — sem cobrança` executa somente FFmpeg local: cortes diretos,
1920×1080, 24 fps, sem áudio. Não chama Codex, Runpod, TTS ou outro fornecedor.
Clipes ausentes bloqueiam a montagem; não há substituição por cenas vizinhas.
Para vídeos gerados na GPU controlada pelo Conveyer, a prontidão inclui a parada
verificada da sessão. Um MP4 importado do Colab/Kaggle é validado localmente e
registrado como upload; ele não afirma que uma sessão GPU externa foi parada.

Uma trava impede montagens concorrentes do mesmo roteiro. Os clipes são
conferidos por SHA-256 antes e depois, e o resultado e seu manifesto são gravados
atomicamente. Falhas preservam a montagem anterior. O vídeo pode ser assistido e
baixado na página; a entrega suporta requisições parciais para reprodução.

A montagem real do teste do liquidificador foi conferida: 145 frames, 24 fps,
1920×1080, aproximadamente 6,04 segundos, sem faixa de áudio. O teste de duas
cenas verifica a ordem dos clipes, ausência de áudio, bloqueio de cenas ausentes,
preservação do resultado anterior e detecção de alteração do arquivo.

## Narração AI33 Pro e duração das cenas (2026-10-07)

O roteiro salvo permite preparar e autorizar uma narração por cena pelo AI33 Pro,
conforme a escolha do operador. Isso não altera `VOICEOVER_PROVIDER` global.
Preparar é local e usa `AI33_VOICE_ID`, `AI33_BASE_URL` e `TTS_SPEED` configurados;
nenhuma chave é enviada ao navegador. O motor é determinado pela voz, sem inventar
um modelo separado. A lista real de vozes respondeu HTTP 200 e usa ids com prefixo
como `elevenlabs_...`; este fluxo preserva o id configurado literalmente.

A autorização é vinculada ao texto, voz, endereço e velocidade. Um arquivo exclusivo
é gravado antes do único POST de síntese: falha, timeout, resposta perdida ou clique
duplicado nunca provocam repetição. A resposta de criação é preservada localmente
para recuperar um crash anterior ao salvamento do id. Consultar resultado existente
somente consulta a tarefa e baixa seu áudio. Sem id recuperável, requer diagnóstico
do histórico do fornecedor. O custo exato não é estimado: créditos retornados pelo
AI33 ficam no registro da cena e são mostrados na tela; não entram ainda na página
geral Costs, porque o rascunho não é um run Studio.

O áudio é decodificado localmente, medido por ffprobe e conferido por SHA-256.
Limites: download de 80 MB e dez minutos por cena. Montar com narração exige todos
os áudios e clipes válidos. Cada cena é cortada ou prolongada com a última imagem
parada até terminar sua fala, arredondando somente ao próximo frame de 24 fps.
A velocidade da voz não muda. Intermediários têm áudio PCM; AAC é codificado uma
única vez no final para evitar atraso acumulado entre cenas. A versão sem narração
é preservada separadamente.

Não há transcrição externa, geração em lote ou envio automático de cenas seguintes.
Uma voz por cena pode apresentar diferenças de entonação nos cortes. A montagem
narrada foi testada com dois clipes e tons locais; uma geração real no AI33 neste
fluxo ainda aguarda autorização específica. A documentação autenticada não pôde
ser consultada (HTTP 401); criação e recuperação reutilizam o contrato do adaptador
AI33 existente no projeto e precisam de validação na primeira chamada autorizada.

## Full script / Create a video

Choose `GPT images + LTX videos` in Create a video. The real/AI percentage remains
unchanged; the second percentage divides only AI b-roll into GPT stills and LTX
videos (rounded to whole scenes). The choice and ratio are saved in this run's
configuration. Existing runs and channel voice/key settings keep their behavior.
Creating a run still invokes the channel's narration/planning providers; it is
not a free preview. GPT and GPU execution have separate approval gates.

When the pipeline pauses for missing scenes, the run page prepares a local image
batch. Approval names the exact pending image IDs. One-use job claims prevent
repeat clicks or restarts from resending paid turns. Up to **four persistent Codex
processes per account** work concurrently; one conversation at a time per process.
The fifth job waits. Each process is recycled after **50 conversations**; idle
processes close after 30 seconds and release the account owner lock. All batches
and single-scene requests share the same queue. Another server owning the account
is refused. Failed generations are never retried automatically; recovery reads
the recorded thread instead.

Completed images are validated, saved and applied to their original scene only.
LTX videos use those saved images through `Usar imagem GPT já salva` in the scene
page, without another image generation. GPU rounds remain separately authorized
and guarded. This change does **not** provide automatic GPU rental or an unattended
multi-video GPU batch. Once every required scene is ready, Resume reuses the saved
narration, footage and AI assets before assembly. A failed batch reservation may
leave consumed jobs blocked for operator inspection; it must never be retried as
a fresh billable submission.
