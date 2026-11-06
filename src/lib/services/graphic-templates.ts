import { z } from "zod";

/**
 * Graphic-beat templates: the data contract of each page in src/graphics/templates.
 *
 * Every template's `data` is validated here BEFORE a browser is touched. The template's
 * JS trusts what it is given (it writes text with textContent, never innerHTML), so this
 * schema is the only gate. Schemas are `.strict()`: an unknown key is a planner mistake,
 * and the caller's answer to a rejection is to render the beat as ordinary b-roll.
 *
 * `stamp` is not a template of its own: it is a layer (spec 3.3 #10) that product_hero,
 * spec_callouts and checklist_card accept through `data.stamp`.
 */

export const GRAPHIC_TEMPLATE_KEYS = [
  "product_hero",
  "spec_callouts",
  "kinetic_quote",
  "impact_bars",
  "counter",
  "versus",
  "checklist_card",
  "polaroids",
  "timeline",
] as const;
export type GraphicTemplateKey = (typeof GRAPHIC_TEMPLATE_KEYS)[number];

export const GRAPHIC_THEMES = ["arden"] as const;
export type GraphicTheme = (typeof GRAPHIC_THEMES)[number];

/** A narration word, timed relative to the START of the beat. */
export type GraphicWord = { text: string; startMs: number; endMs: number };

const bg = z.enum(["dark", "parchment"]);

/**
 * Where a template image comes from. `sample:<name>` is a bundled placeholder
 * (src/graphics/samples/<name>.svg); an absolute path is a local file; data: and
 * http(s) URLs are handed to the page as-is. `product:<name>` is what the PLANNER writes:
 * a named product the pipeline must resolve to a cut-out (product-cutout.ts) before
 * rendering — the renderer refuses one that reaches it unresolved.
 */
export const PRODUCT_REF = /^product:(.{2,60})$/;
const imageRef = z
  .string()
  .min(1)
  .refine(
    (s) => /^sample:[a-z0-9_-]+$/i.test(s) || /^data:image\//.test(s) || /^https?:\/\//.test(s) || s.startsWith("/") || PRODUCT_REF.test(s),
    { message: "image must be product:<name>, sample:<name>, an absolute path, a data:image URL or an http(s) URL" },
  );

const shortText = (max: number) => z.string().trim().min(1).max(max);
const cue = z.string().trim().min(1).max(40);

/** The red stamp layer. A bare string is accepted as {text}. */
const stampSchema = z.preprocess(
  (v) => (typeof v === "string" ? { text: v } : v),
  z.object({ text: shortText(28), cueWord: cue.optional() }).strict(),
);

export const productHeroSchema = z
  .object({
    image: imageRef,
    title: shortText(60),
    overline: shortText(40).optional(),
    subtitle: shortText(90).optional(),
    reveal: z.boolean().optional(),
    /** reveal: the word on which the silhouette lights up (default ~40% into the beat) */
    revealCue: cue.optional(),
    /** small gold-outlined chip under the subtitle ("SAME BUILD, 1984 MINI") */
    chip: shortText(40).optional(),
    chipCue: cue.optional(),
    productSide: z.enum(["left", "right"]).optional(),
    stamp: stampSchema.optional(),
    bg: bg.default("dark"),
  })
  .strict();

export const specCalloutsSchema = z
  .object({
    image: imageRef,
    name: shortText(40),
    /** small mono line under the name ("EDC FLASHLIGHT") */
    sub: shortText(60).optional(),
    price: shortText(16).optional(),
    specs: z
      .array(
        z
          .object({
            label: shortText(32),
            sub: shortText(60).optional(),
            /** point on the product, as a fraction of the drawn image (0..1, 0..1) */
            anchor: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).strict(),
            cueWord: cue.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(6),
    labelsSide: z.enum(["left", "right"]).optional(),
    stamp: stampSchema.optional(),
    bg: bg.default("dark"),
  })
  .strict();

export const kineticQuoteSchema = z
  .object({
    text: shortText(140),
    highlight: z.array(shortText(60)).max(8).default([]),
    style: z.enum(["typewriter", "outline-fill"]).default("outline-fill"),
    /** small mono label above the frame ("PEAK SHARE") */
    label: shortText(40).optional(),
    /** outline-fill only: fill the hollow letters once typing ends (default true) */
    fillAtEnd: z.boolean().optional(),
    bg: bg.default("parchment"),
  })
  .strict();

export const impactBarsSchema = z
  .object({
    lines: z
      .array(
        z
          .object({
            text: shortText(40),
            /** gold bar instead of the parchment one */
            gold: z.boolean().optional(),
            /** no bar at all: plain text on the background */
            plain: z.boolean().optional(),
            /** shown, then struck through when the next line arrives */
            strike: z.boolean().optional(),
            cueWord: cue.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(4),
    label: shortText(40).optional(),
    bg: bg.default("dark"),
  })
  .strict();

export const counterSchema = z
  .object({
    value: z.number().int().min(0).max(999_999_999_999),
    /** where the roll starts (default 0, which keeps the leading zeros of the reference) */
    from: z.number().int().min(0).max(999_999_999_999).optional(),
    prefix: shortText(4).optional(),
    suffix: shortText(20).optional(),
    caption: shortText(80).optional(),
    overline: shortText(40).optional(),
    /** gold title under the caption ("THE HANDOFF") */
    kicker: shortText(30).optional(),
    image: imageRef.optional(),
    bg: bg.default("dark"),
  })
  .strict();

const versusSide = z
  .object({
    name: shortText(30),
    sub: shortText(40).optional(),
    image: imageRef.optional(),
    bullets: z.array(shortText(44)).max(4).default([]),
    /** red bullet markers: the side being argued against */
    bad: z.boolean().optional(),
  })
  .strict();

export const versusSchema = z
  .object({
    title: shortText(40).optional(),
    overline: shortText(40).optional(),
    left: versusSide,
    right: versusSide,
    winner: z.enum(["left", "right"]).optional(),
    /** ribbon across the middle ("PHONE WINS"); defaults to "<WINNER> WINS" */
    ribbon: shortText(30).optional(),
    ribbonCue: cue.optional(),
    bg: bg.default("dark"),
  })
  .strict();

export const checklistCardSchema = z
  .object({
    title: shortText(40),
    subtitle: shortText(80).optional(),
    overline: shortText(40).optional(),
    items: z
      .array(
        z
          .object({
            text: shortText(48),
            /** small italic aside after the text ("instead of belt holsters") */
            note: shortText(40).optional(),
            state: z.enum(["check", "cross", "empty"]),
            cueWord: cue.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(6),
    stamp: stampSchema.optional(),
    /** product beside the card (the card then sits right, on a dark ground) */
    image: imageRef.optional(),
    bg: bg.optional(),
  })
  .strict();

export const polaroidsSchema = z
  .object({
    label: shortText(40).optional(),
    photos: z
      .array(z.object({ image: imageRef, caption: shortText(40), cueWord: cue.optional() }).strict())
      .min(1)
      .max(5),
    bg: z.enum(["wood-light", "wood-dark", "dark"]).default("wood-light"),
  })
  .strict();

export const timelineSchema = z
  .object({
    /** small mono label top-left ("RUNNING OUT") */
    title: shortText(40).optional(),
    events: z
      .array(z.object({ year: z.number().int().min(0).max(9999), label: shortText(32), sub: shortText(60).optional() }).strict())
      .min(2)
      .max(6),
    /** index of the event the big year lands on (default: the last) */
    focus: z.number().int().min(0).optional(),
    bg: bg.default("dark"),
  })
  .strict()
  .refine((d) => d.focus == null || d.focus < d.events.length, { message: "focus must index an event", path: ["focus"] });

type TemplateEntry = { label: string; schema: z.ZodTypeAny; sample: Record<string, unknown>; sampleNarration: string };

export const GRAPHIC_TEMPLATES = {
  product_hero: {
    label: "Product hero",
    schema: productHeroSchema,
    sample: { image: "sample:flashlight", overline: "1984", title: "Mini Maglite", subtitle: "America's pocket flashlight", bg: "dark" },
    sampleNarration: "In 1984 Maglite shrank its famous flashlight into something you could carry every single day.",
  },
  spec_callouts: {
    label: "Spec callouts",
    schema: specCalloutsSchema,
    sample: {
      image: "sample:flashlight",
      name: "Mini Maglite",
      sub: "Twist to turn on",
      price: "$25",
      specs: [
        { label: "Machined aluminum body", sub: "Anodized, built to be dropped", anchor: { x: 0.6, y: 0.5 }, cueWord: "aluminum" },
        { label: "Twist-focus head", sub: "Flood to a tight spot", anchor: { x: 0.12, y: 0.5 }, cueWord: "head" },
        { label: "Belt holster", sub: "Rides on your belt", anchor: { x: 0.94, y: 0.5 }, cueWord: "holster" },
      ],
      bg: "dark",
    },
    sampleNarration: "A machined aluminum body, a head you twist to focus the beam, and a belt holster in the box.",
  },
  kinetic_quote: {
    label: "Kinetic quote",
    schema: kineticQuoteSchema,
    sample: { text: "Everything else was built to outlast you.", highlight: ["outlast you"], style: "outline-fill", label: "Mag Instrument", bg: "parchment" },
    sampleNarration: "Everything else was built to outlast you.",
  },
  impact_bars: {
    label: "Impact bars",
    schema: impactBarsSchema,
    sample: { lines: [{ text: "Something" }, { text: "that good" }, { text: "gets copied.", gold: true }], bg: "dark" },
    sampleNarration: "Something that good gets copied.",
  },
  counter: {
    label: "Counter",
    schema: counterSchema,
    sample: { value: 39000000, suffix: "a year", caption: "lights made a year at the California plant", overline: "By the end of the nineties", image: "sample:flashlight", bg: "dark" },
    sampleNarration: "By the end of the nineties the California plant was making thirty-nine million lights a year.",
  },
  versus: {
    label: "Versus",
    schema: versusSchema,
    sample: {
      title: "Phone vs Mini Mag",
      overline: "The small jobs",
      left: { name: "Phone flashlight", sub: "Already in your pocket", image: "sample:phone", bullets: ["Finds keys under a seat", "Reads a breaker label"] },
      right: { name: "Mini Maglite", sub: "AA, incandescent bulb", image: "sample:flashlight", bullets: ["Needs its own batteries", "A separate tool to carry"], bad: true },
      winner: "left",
      ribbon: "Phone wins",
      bg: "dark",
    },
    sampleNarration: "For the small jobs, the phone already in your pocket finds the keys and reads the breaker label. The Mini Mag needs its own batteries. The phone wins.",
  },
  checklist_card: {
    label: "Checklist card",
    schema: checklistCardSchema,
    sample: {
      overline: "LED-first designs",
      title: "What changed",
      subtitle: "Built around the LED from scratch",
      items: [
        { text: "Pocket clips", note: "instead of belt holsters", state: "check" },
        { text: "Tail switches", note: "one with a thumb", state: "check" },
        { text: "Lithium cells", state: "check" },
        { text: "Low modes", note: "runs for days", state: "check" },
      ],
      bg: "parchment",
    },
    sampleNarration: "What changed? Pocket clips instead of holsters, tail switches you hit with a thumb, lithium cells, and low modes that run for days.",
  },
  polaroids: {
    label: "Polaroids",
    schema: polaroidsSchema,
    sample: {
      label: "One cop's career",
      photos: [
        { image: "sample:flashlight", caption: "Maglite in the cruiser" },
        { image: "sample:knife", caption: "Buck 110, always on him" },
        { image: "sample:flashlight", caption: "Streamlight Stinger" },
      ],
      bg: "wood-light",
    },
    sampleNarration: "A guy I know carried a Maglite in the cruiser, a Buck 110 on his belt, and later a Streamlight Stinger.",
  },
  timeline: {
    label: "Timeline",
    schema: timelineSchema,
    sample: {
      title: "Running out",
      events: [
        { year: 1981, label: "Patent granted" },
        { year: 1998, label: "Patent expires", sub: "The original design protection ends" },
        { year: 2004, label: "Mini's patent ends", sub: "The Mini Maglite is now open" },
      ],
      bg: "dark",
    },
    sampleNarration: "The patent was granted in 1981. It expired in 1998, and by 2004 the Mini's own patent had ended too.",
  },
} as const satisfies Record<GraphicTemplateKey, TemplateEntry>;

export function isGraphicTemplateKey(v: unknown): v is GraphicTemplateKey {
  return typeof v === "string" && (GRAPHIC_TEMPLATE_KEYS as readonly string[]).includes(v);
}

export type GraphicValidation =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string };

export function validateGraphicData(template: string, data: unknown): GraphicValidation {
  if (!isGraphicTemplateKey(template)) return { ok: false, error: `unknown graphic template "${template}"` };
  const parsed = GRAPHIC_TEMPLATES[template].schema.safeParse(data);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    return { ok: false, error: `${template}: ${msg}` };
  }
  return { ok: true, data: parsed.data as Record<string, unknown> };
}

/**
 * Evenly timed words for a narration line — what /tools/graphic-preview uses in place of
 * real word timings. The line is spoken over the first `fraction` of the beat.
 */
export function syntheticWords(text: string, durationMs: number, fraction = 0.85): GraphicWord[] {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const span = Math.max(1, durationMs * fraction);
  const step = span / tokens.length;
  return tokens.map((t, i) => ({
    text: t,
    startMs: Math.round(i * step),
    endMs: Math.round(i * step + step * 0.85),
  }));
}
