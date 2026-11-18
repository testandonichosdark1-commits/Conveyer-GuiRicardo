# Fábrica de vídeos — guia de instalação e uso

A Fábrica (`/factory`) recebe **títulos** e produz, para cada um, roteiro + descrição → thumbnail →
narração + b-roll + montagem do vídeo. Vários vídeos rodam ao mesmo tempo (padrão: 3). O vídeo
final fica na pasta de dados do app (padrão `~/.faceless-studio`, ou `FACELESS_STUDIO_DATA_DIR`), em
`runs/<nome>/final.mp4`; a página do run (`Vídeo e log`) também mostra.

Desenhada para **custo zero e zero risco de direitos autorais**: só b-roll real de bancos
gratuitos, nunca IA paga, e só material em domínio público, CC0 ou licença livre.

## Quem faz o quê

| Etapa | Ferramenta | Custo |
|---|---|---|
| Roteiro, descrição, prompt da thumbnail | Claude Code (`claude -p`) com as skills `roteiro-7-things` e `foxhole-thumbnail-generator` | assinatura do Claude |
| Planejamento das cenas | Claude Haiku (`PLANNER_ENGINE=claude`) | assinatura do Claude |
| Imagem da thumbnail (cena + texto + seta, de uma vez) | ChatGPT, pela conta ChatGPT/Codex | cota do plano ChatGPT |
| Avaliação das imagens do b-roll | ChatGPT (`VISION_SCORING=chatgpt`) | cota do plano ChatGPT |
| Narração | VoiceStudio local (motor `mlx-audio`, voz `am_michael`) | grátis |
| Tempo das palavras | Groq Whisper | ~€0,05/vídeo (plano gratuito do Groq existe) |
| Bancos de b-roll | Pexels, Pixabay, Wikimedia, NASA, Smithsonian, Openverse, archive.org, Wigolo (+ Web/Google se tiver chave) | grátis |
| Montagem | FFmpeg | grátis |

## O que instalar (macOS, Apple Silicon)

1. **Node 20+** e **FFmpeg** (`brew install node ffmpeg`).
2. **Claude Code**, logado (`claude` no terminal). Teste: `claude -p "diga ok"`.
3. **As duas skills** (ficam fora do Git, porque contêm os briefs dos canais). Receba o arquivo
   `skills-fabrica.zip` e, na raiz do projeto:
   ```bash
   unzip skills-fabrica.zip -d skills
   ./scripts/install-skills.sh
   ```
4. **VoiceStudio** (voicestudio.sh). Abra uma vez e confirme que o motor `mlx-audio` funciona. O app
   reabre o VoiceStudio sozinho se ele fechar durante uma narração.
5. **Conta do ChatGPT para imagens e avaliação** — uma pasta própria, separada do seu Codex pessoal:
   ```bash
   B="$HOME/Documents/Codex/conveyer-private/codex-images"
   mkdir -p "$B/account" "$B/workspace"          # workspace tem de ficar VAZIA
   CODEX_HOME="$B/account" /Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex login
   ```
   Não crie `config.toml` dentro de `account/`. Sem esta conta, a thumbnail falha (o vídeo segue
   mesmo assim) e a avaliação das imagens cai para uma busca por palavras (pior).
6. **Projeto:** `npm install` e depois `npm run dev` (porta 3000).

## Chaves de API (Settings → API keys)

Ficam no banco local de cada pessoa, nunca no Git. Todas gratuitas:

| Chave | Onde pegar | Obrigatória? |
|---|---|---|
| `PEXELS_API_KEY` | pexels.com/api | sim (principal fonte de vídeo) |
| `PIXABAY_API_KEY` | pixabay.com/api/docs | recomendada |
| `GROQ_API_KEY` | console.groq.com | sim (tempo das palavras) |
| `SMITHSONIAN_API_KEY` | api.data.gov/signup (sai na hora) | opcional |
| `GOOGLE_API_KEY` | aistudio.google.com/apikey | só se for usar o Gemini (veja abaixo) |

NASA e Wigolo não precisam de chave. Wikimedia, Openverse e archive.org também não.

## Como usar

1. Abra `localhost:3000/factory`.
2. Cole **um título por linha** (formato "7 Things … Found Strange About …"), escolha o formato do
   roteiro (a, b ou c) e mantenha **"Custo zero"** ligado.
3. **Produzir.** Cada cartão mostra a etapa atual. Um vídeo de 25 min leva cerca de 1h30 (a maior
   parte é busca e avaliação de imagens). Se falhar, **Tentar de novo** retoma de onde parou.
4. Roteiro, descrição, thumbnail, "fatos a checar" e `credits.txt` (fonte de cada asset) abrem pelos
   links do cartão.

## Configurações que fazem a diferença

Já vêm como padrão numa instalação nova (Settings → full settings):

| Chave | Padrão | Para quê |
|---|---|---|
| `VISION_SCORING` | `chatgpt` | quem avalia as imagens: `chatgpt` · `claude` · vazio = Gemini · `off` = só busca por palavras (resultado bem pior) |
| `CHATGPT_VISION_MODEL` | vazio (= gpt-6.2-sol) | modelo do avaliador; `codex debug models` lista os disponíveis |
| `PLANNER_ENGINE` | `claude` | `gemini` volta o planejamento para o Gemini |
| `REAL_MEDIA` | `auto` | fotos **e** vídeos (só vídeo deixa muitas cenas sem asset) |
| `REAL_STRICT_MIN_SCORE` | `50` | nota mínima para um asset entrar; abaixo disso a cena vizinha continua |
| `HOOK_SECONDS_PER_VISUAL` / `HOOK_SEC` | `3` / `40` | cortes nos primeiros 40 s |
| `FOOTAGE_SOURCES` | só fontes livres | YouTube e Storyblocks ficam **desligados** em instalação nova |

Cena sem asset bom **nunca repete** um clipe: a cena vizinha continua pelo tempo dela.

## O estilo do vídeo (documentário no formato "7 Things")

Já vem ligado numa instalação nova:

| Chave | Padrão | O que faz |
|---|---|---|
| (a Fábrica liga os cartões) | — | cartão "NUMBER SEVEN", anos, tarjas de nome e frases de destaque, desenhados dentro de cada cena |
| `VIDEO_GRADE` | `documentary` | cor mais apagada + vinheta em todas as cenas; `off` desliga |
| `GRADE_ARCHIVAL_STOCK_BW` | `1` | vídeo de estoque que cobre um momento histórico vira preto e branco |
| `SECONDS_PER_VISUAL` / `HOOK_SECONDS_PER_VISUAL` | `6` / `3` | cada cena dura ~6 s; no hook (40 s) ~3 s |
| `ENCODE_PRESET` | `veryfast` | velocidade da compressão; `medium` é 2–3x mais lento |
| `OVERLAYS_IN_SCENES` | `1` | cartões dentro da montagem de cada cena (paralelo); `0` = passada única antiga |
| `VISION_SPECIFIC_SUBJECT` | `1` | cena que cita pessoa, unidade, lugar ou época recusa substituto genérico ou moderno; `0` volta ao avaliador antigo |
| `PLANNER_FALLBACK_QUERY` | `1` | o planejador escreve uma segunda busca (lugar, mapa, objeto) para cenas com nome próprio; usada se a primeira não achar nada bom |
| `REAL_STRICT_MIN_SCORE` | `50` | nota mínima para uma imagem entrar |
| `VISUAL_CONCURRENCY` / `CHATGPT_VISION_CONCURRENCY` / `ASSEMBLE_CONCURRENCY` | `10` / `6` / `4` | quantas cenas, avaliações e montagens ao mesmo tempo (suba a montagem para o nº de núcleos do processador) |

Ainda não existe: legenda com a palavra falada em destaque, música de fundo e som de impacto
nos cartões, zoom de mapa de satélite.

## Se algo der errado

- **"ChatGPT account is not set up"** → passo 5. A pasta `workspace` precisa estar vazia.
- **"Esta pasta já está em uso ou tem uma trava pendente"** → só um programa por vez usa a conta do
  ChatGPT. Se não houver nenhuma geração rodando, apague `…/codex-images/account/conveyer-image.lock`.
- **VoiceStudio "not reachable"** → abra o app e espere ele carregar; o run retoma sozinho.
- **Roteiro não gera** → confira `claude -p "ok"` e se as skills estão em `~/.claude/skills`.
- **Muitos erros 429 do Wikimedia** → normal sob carga; o app já espaça e repete os pedidos.
- **Limite do Gemini (429)** → só acontece se `VISION_SCORING` estiver vazio e a chave for gratuita.
  Use `chatgpt` ou `claude`.

## Limites conhecidos

- Só macOS (VoiceStudio e a conta Codex local).
- Web (Google) só funciona com `GOOGLE_CSE_KEY` + `GOOGLE_CSE_CX`; sem elas não faz nada.
- Wigolo busca imagens na web aberta e não garante licença. Para risco zero de direitos autorais,
  tire `wigolo` e `web` de `FOOTAGE_SOURCES`.
- Fotos de acervo às vezes trazem régua ou cartela de cor; o avaliador recusa marca d'água e logos,
  mas não pega tudo.
- A comparação entre avaliadores (ChatGPT × Claude) foi feita em poucos vídeos curtos.
