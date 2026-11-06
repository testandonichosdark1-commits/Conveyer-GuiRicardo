# SPEC — Camada de Motion Graphics ("graphic beats")

> Para o Claude Code. Leia o `CLAUDE.md` antes. Siga as convenções do projeto:
> tudo novo atrás de configuração, desligado por padrão, e **um run sem a opção ligada
> precisa planejar e renderizar byte-idêntico ao de hoje**. Teste com vitest.

## 1. Objetivo

Replicar o formato do vídeo de referência "Whatever Happened to Maglite?" (canal Arden EDC).
No vídeo de referência, cerca de 70% do tempo de tela são **cenas gráficas em tela cheia,
animadas e desenhadas sob medida**; só ~30% são cenas filmadas.

Referência visual: `docs/reference/maglite/sheet_XX.jpg`. São 15 folhas, uma por minuto,
com frames a cada 3 s e o timestamp no canto. **Abra e estude essas imagens antes de desenhar os templates.**

### O que o vídeo de referência tem (medido)

- **Áudio:** só voz. Não tem música nem efeitos sonoros; isso já está correto hoje, não adicionar.
- **Cortes:** 124 cortes secos em 15 min, com mediana de 5 s por plano. 104 de 123 cortes caem
  em pausas da narração (o planner sentence-aware atual já faz isso).
- **Dentro de cada plano a arte se monta progressivamente:** o elemento visual muda a cada 2–3 s.
  Cenas gráficas de produto seguram 15–60 s enquanto as especificações entram uma a uma.
- **Sem legendas queimadas** e **sem avatar falando**. Há um personagem recorrente nas cenas
  filmadas (homem de 40 e poucos anos, barba, garagem/bancada).

## 2. O que a ferramenta tem hoje (não reescrever)

- `BeatLayout = "avatar" | "split" | "broll"` (`studio-plan.ts`).
- O overlay é um PNG estático com fade, renderizado por sharp/SVG (`overlay-renderer.ts`,
  `overlay-themes.ts`). Tipos: date/title/person/fact/quote/section.
- `studio-assemble.ts` renderiza cada beat silencioso no tempo exato, concatena com corte
  seco e faz o mux da narração.
- O ffmpeg-alvo **não tem drawtext nem libass**. Não depender deles.
- `playwright` já está nas dependências.

## 3. O que construir

### 3.1 Novo layout `"graphic"`

- Adicionar `"graphic"` ao `BeatLayout`.
- Um beat graphic carrega:

```ts
graphic?: {
  template: GraphicTemplateKey;     // ver 3.3
  data: Record<string, unknown>;    // campos do template, validados por zod por template
  theme?: string;                   // default: tema do canal
}
```

- Em `studio-pipeline.ts`, beats graphic **não** passam por `visual-source.ts`. Vão para um novo
  `services/graphic-renderer.ts`, que devolve um clipe MP4 silencioso com a duração exata do beat.
  A partir daí, o `studio-assemble.ts` trata o clipe como qualquer outro.

### 3.2 Renderer: HTML/CSS + Playwright, determinístico

- **Templates:** cada template é uma página HTML/CSS/JS em `src/graphics/templates/<key>.html`,
  com um JS comum (`runtime.js`) que expõe:
  - `window.__setup(data, theme, words)`: monta a cena. `words` são as palavras do beat com
    `startMs`/`endMs` **relativos ao início do beat**, tirados dos word timings que já existem.
  - `window.__seek(ms)`: posiciona TODAS as animações naquele instante. Usar Web Animations API
    com `animation.pause(); animation.currentTime = ms`, ou uma timeline própria. **Nada de
    `setTimeout` nem de relógio real.**
- **Captura:** Chromium headless no tamanho de saída do run (1920×1080 por padrão). Para cada frame
  (30 fps), chamar `__seek(i*1000/30)` e tirar screenshot. Mandar os PNGs por pipe para o ffmpeg
  (`-f image2pipe`), gerando H.264/yuv420p com a duração exata.
- **Performance:**
  - Reaproveitar um único browser por run, com `GRAPHIC_RENDER_CONCURRENCY` páginas (default 2).
  - Se um trecho do template ficar estático por mais de N frames, pode duplicar o frame em vez de
    capturar de novo (otimização opcional, com teste).
- **Fontes:** embutidas por `@font-face` com arquivos em `src/graphics/fonts/`. Isso resolve o
  problema de fontconfig descrito em `overlay-themes.ts`. Usar fontes com licença OFL:
  - **Oswald:** títulos em caixa alta, condensada.
  - **EB Garamond Italic:** legendas e citações.
  - **JetBrains Mono ou IBM Plex Mono:** rótulos pequenos.
- **Falha:** se um beat graphic falhar ao renderizar, ele vira um beat `broll` normal, com a mesma
  frase, pelo caminho atual. Isso fica no log. **Nunca derrubar o run.**

### 3.3 Templates (fase 1: os 10 essenciais)

Tema `arden` (default para graphic beats):

| Token | Valor aproximado |
|---|---|
| Fundo escuro | `#141210`, com vinheta quente radial |
| Pergaminho | `#E9E0CC`, com textura sutil de papel (ruído CSS ou PNG pequeno) |
| Dourado (destaque) | `#B98A2E` (texto) e `#C9A227` (linhas/réguas) |
| Texto claro | `#F3EDE2` |
| Texto escuro | `#1E1A15` |
| Vermelho carimbo | `#B23A2E` |

Os templates abaixo são os da fase 1. Os tempos (`mm:ss`) indicam onde ver cada um nas folhas de
referência.

1. **`product_hero`** (00:00, 01:51, 06:15)
   - Produto recortado (PNG transparente) à esquerda, raios de luz radiais atrás e sombra
     elíptica embaixo, com leve flutuação.
   - Título grande à direita (Oswald), sobrelinha pequena (ano/categoria) e subtítulo em itálico.
   - Variante `reveal` (01:48, 12:30): silhueta preta com brilho dourado e "???", que depois
     revela o produto.
   - `data: { image, title, overline?, subtitle?, reveal?: boolean, bg: "dark"|"parchment" }`
2. **`spec_callouts`** (02:00, 10:12, 14:12)
   - Produto no centro/direita. Rótulos numerados (01, 02…) com linha fina apontando para pontos
     do produto. Cada rótulo entra quando sua palavra-chave é dita.
   - Nome do produto e preço em chip dourado no canto inferior esquerdo.
   - `data: { image, name, price?, specs: [{label, sub?, anchor:{x,y}, cueWord?}] }`
3. **`kinetic_quote`** (01:15, 02:33, 04:33, 10:30)
   - Frase digitada letra a letra dentro de moldura com cantos e régua inferior. Palavras-chave
     viram dourado sólido. A versão "contorno" vira preenchida no fim.
   - Fundo pergaminho ou escuro.
   - `data: { text, highlight: string[], style: "typewriter"|"outline-fill", bg }`
4. **`impact_bars`** (02:30, 06:42, 07:21)
   - Linhas de texto em tarjas, uma ou mais em fundo dourado. Opcional: a primeira linha aparece
     e depois é riscada (`strike`).
   - `data: { lines: [{text, gold?: boolean, strike?: boolean}] }`
5. **`counter`** (00:21, 02:45, 07:12)
   - Número grande rolando até o valor final, estilo odômetro, com prefixo/sufixo e legenda
     pequena. Produto opcional ao lado.
   - `data: { value: number, prefix?, suffix?, caption?, image? }`
6. **`versus`** (06:27, 09:12, 13:06)
   - Duas colunas com divisor vertical e selo "VS" no centro, bullets de cada lado e faixa de
     vencedor ("PHONE WINS", "WHY I SWITCHED").
   - `data: { title?, left:{name,image?,bullets[]}, right:{...}, winner?: "left"|"right", ribbon? }`
7. **`checklist_card`** (06:06, 09:00, 12:57)
   - Cartão de papel inclinado com título. Itens entram e são marcados (✓ ou ✗ riscado), com
     carimbo opcional ("NOT COVERED").
   - `data: { title, subtitle?, items:[{text, state:"check"|"cross"|"empty"}], stamp? }`
8. **`polaroids`** (02:12, 07:48, 10:00)
   - Mesa de madeira (ou fundo escuro). Polaroids caem uma a uma, com rotação leve e legenda
     manuscrita.
   - `data: { label?, photos:[{image, caption}] }`
9. **`timeline`** (04:06–04:12)
   - Eixo horizontal com marcadores. O ano grande entra rolando e os eventos vão sendo listados.
   - `data: { title?, events:[{year, label}] , focus?: number }`
10. **`stamp`**
    - Camada de carimbo vermelho ("SUED", "STILL CARRY IT", "KEYCHAIN PICK") que pode ser
      combinada com `product_hero` ou `spec_callouts` através de `data.stamp`.

**Fase 2 (depois de validar a fase 1):**

- `newspaper` (06:45)
- `quote_card` com iniciais (06:57)
- `redacted_doc` (10:18)
- `split_flap` (13:33)
- `ui_toggle` (13:51)
- `product_grid_pick` (13:24)

**Sincronização com a fala:** qualquer elemento com `cueWord` aparece no `startMs` da primeira
ocorrência daquela palavra dentro do beat. Sem `cueWord`, distribuir as entradas uniformemente nos
primeiros 60% do beat.

### 3.4 Planner (`studio-plan.ts`)

Ligado por `GRAPHICS_ENABLED=1`, configurável por canal (`channels`), **off por padrão**.

**Proporção:** `GRAPHIC_BEAT_PERCENT` (default 65). Se `GRAPHICS_ENABLED=1`,
`AVATAR_FREQUENCY_PERCENT` passa a ser tratado como 0 para aquele run.

**Duração variável:**

- **Footage (`broll`):** mantém `SECONDS_PER_VISUAL` (sugestão 3.5–4.5 s).
- **Graphic:** pode juntar frases consecutivas sobre o mesmo assunto até `GRAPHIC_MAX_SEC`
  (default 20; `spec_callouts` e listas até 45).
- **Sempre cortar em fronteira de frase.**

**Prompt:** adicionar ao prompt do planner (em um chunk novo, sem alterar o texto atual quando a
opção estiver desligada) as seguintes regras:

- **Frase de efeito curta e autossuficiente** ("Something that good gets copied.") →
  `kinetic_quote` ou `impact_bars`.
- **Número/valor/ano marcante** → `counter` ou `timeline`.
- **Produto nomeado sendo apresentado** → `product_hero`. Se a narração lista atributos dele,
  usar `spec_callouts`.
- **Comparação explícita entre duas coisas** → `versus`.
- **Lista de mudanças, garantia ou veredito** → `checklist_card`.
- **Pessoas/objetos de uma história pessoal** ("a guy I know… a Buck 110 and a Mini Mag") →
  `polaroids`.
- **Ação física, ambiente, memória, pessoa fazendo algo** → `broll` (cena filmada com o
  personagem recorrente).
- **Não repetir o mesmo template em dois beats seguidos.**
- **Texto na tela é curto:** títulos ≤ 6 palavras e frase de efeito ≤ 12 palavras, copiadas da
  narração.

**Saída:** JSON validado por zod por template. Inválido → o beat vira `broll` (fail-open, como o
resto do projeto).

### 3.5 Imagens de produto recortadas

Novo `services/product-cutout.ts`:

1. **Obter a imagem:**
   - Se a fonte real estiver ligada, buscar a foto pelo caminho de fotos que já existe
     (wigolo/Openverse) com `"<produto> product photo white background"`.
   - Senão, gerar pelo provedor de IA atual usando o `product_label` que já existe.
2. **Remover o fundo:** usar `@imgly/background-removal-node` (roda local, sem API) ou `rembg`
   via Python, conforme o que instalar sem fricção no Mac do usuário. Saída em PNG transparente,
   recortado ao conteúdo.
3. **Cache:** por nome normalizado do produto em `~/.faceless-studio/products/`. O mesmo
   produto aparece várias vezes no vídeo e não deve ser buscado/gerado de novo.

### 3.6 Personagem recorrente nas cenas filmadas

- **Verificar:** checar se o caminho ChatGPT/GPT-image (`codex-images*.ts`) e o GPT+LTX aceitam
  imagem de referência.
- **Se aceitam:** ligar a "Character reference image" e `channels.character_terms` também para
  esses provedores, hoje restritos ao Google Flow.
- **Se não aceitam:** documentar e usar uma descrição fixa e detalhada do personagem no prompt de
  cada beat que o mencione.

## 4. UI

- **Canal:** checkbox "Motion graphics (estilo documentário)" + slider "% de cenas gráficas" +
  seletor de tema (`arden`).
- **`/tools/graphic-preview`:** escolhe template + JSON de exemplo e renderiza um clipe de 6 s
  para conferir visualmente. É essencial para iterar o design sem rodar um vídeo inteiro.

## 5. Critérios de aceite

1. **Regressão zero:** com `GRAPHICS_ENABLED` desligado, os testes atuais passam e o plano de um
   run é idêntico ao anterior.
2. **Preview:** cada template da fase 1 renderiza em `/tools/graphic-preview` e é visualmente
   próximo do frame correspondente em `docs/reference/maglite/`.
3. **Run de teste completo:** usar o roteiro do Maglite (transcrição em
   `~/RadarBrechas/transcricoes/qZVqPRuOIa8.txt`) para gerar um vídeo de 15 min e checar:
   - 55–75% do tempo em beats graphic;
   - nenhum template repetido em sequência;
   - elementos com `cueWord` entrando no máximo 150 ms depois da palavra;
   - nenhuma falha de render derrubando o run.
4. **Tempo de render:** documentar no `CLAUDE.md` quanto um vídeo de 15 min leva no Mac do
   usuário.
5. **Documentação:** atualizar o `CLAUDE.md` com uma seção "Graphic beats", no mesmo estilo das
   outras.
