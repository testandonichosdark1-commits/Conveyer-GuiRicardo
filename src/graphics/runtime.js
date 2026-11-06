/*
 * Graphic-beat runtime — shared by every template in ./templates.
 *
 * The renderer (src/lib/services/graphic-renderer.ts) drives a page through two calls:
 *   window.__setup(data, theme, words, { durationMs })  builds the scene, once
 *   window.__seek(ms)                                   poses EVERY animation at ms
 * and screenshots after each seek. There is no clock: every animation is a paused Web
 * Animation whose currentTime is set by __seek, or an onSeek() function of ms. No
 * setTimeout, no requestAnimationFrame loop, no Math.random — the same (data, words, ms)
 * must always produce the same pixels, or a re-render of a beat would not match.
 *
 * The pure helpers at the top (cue scheduling, typing schedule, highlight matching) are
 * exported for vitest through module.exports; in the browser they hang off window.GR.
 */
(function (root) {
  "use strict";

  // ── pure helpers ────────────────────────────────────────────────────────────

  function normalizeWord(w) {
    return String(w == null ? "" : w)
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "");
  }

  function tokenize(text) {
    return String(text == null ? "" : text).split(/\s+/).filter(Boolean);
  }

  /** startMs of the FIRST occurrence of cueWord (one word or a phrase) in words, else null. */
  function cueStart(cueWord, words) {
    var target = tokenize(cueWord).map(normalizeWord).filter(Boolean);
    if (!target.length || !words || !words.length) return null;
    var norm = words.map(function (w) { return normalizeWord(w.text); });
    for (var i = 0; i + target.length <= norm.length; i++) {
      var ok = true;
      for (var k = 0; k < target.length; k++) if (norm[i + k] !== target[k]) { ok = false; break; }
      if (ok) return Math.max(0, Number(words[i].startMs) || 0);
    }
    return null;
  }

  /**
   * Entry time per item. An item with a cueWord found in the beat enters on that word;
   * everything else takes its uniform slot in [windowStartMs, windowEndMs) — by default
   * the first 60% of the beat. Slots are by INDEX over all items, so a cue that is not
   * spoken degrades to the place the item would have had anyway, never to t=0.
   */
  function scheduleEntries(items, words, durationMs, opts) {
    opts = opts || {};
    var start = opts.windowStartMs != null ? opts.windowStartMs : 0;
    var end = opts.windowEndMs != null ? opts.windowEndMs : durationMs * 0.6;
    if (end < start) end = start;
    var n = items.length;
    return items.map(function (item, i) {
      var cued = item && item.cueWord ? cueStart(item.cueWord, words) : null;
      var t = cued != null ? cued : start + ((end - start) * i) / Math.max(1, n);
      return Math.min(Math.max(0, t), Math.max(0, durationMs - 1));
    });
  }

  /**
   * When each on-screen token is typed: [{startMs, endMs}] per token. Tokens are matched to
   * the spoken words in order (a short look-ahead tolerates words the narration adds), so a
   * word is typed while it is said. Unmatched tokens are interpolated between their matched
   * neighbours; with no match at all, typing is spread over the first 60% of the beat.
   * Typing always finishes by 92% of the beat so the completed line is seen.
   */
  function typingSchedule(tokens, words, durationMs, opts) {
    opts = opts || {};
    var n = tokens.length;
    var out = new Array(n);
    var hardEnd = durationMs * 0.92;
    var anchors = [];
    var j = 0;
    words = words || [];
    for (var i = 0; i < n; i++) {
      var t = normalizeWord(tokens[i]);
      if (!t) continue;
      for (var k = j; k < Math.min(words.length, j + 6); k++) {
        if (normalizeWord(words[k].text) === t) {
          var s = Number(words[k].startMs) || 0;
          var e = Math.max(s + 1, Number(words[k].endMs) || s + 1);
          out[i] = { startMs: s, endMs: e };
          anchors.push(i);
          j = k + 1;
          break;
        }
      }
    }
    if (!anchors.length) {
      var fStart = opts.fallbackStartMs != null ? opts.fallbackStartMs : 0;
      var fEnd = opts.fallbackEndMs != null ? opts.fallbackEndMs : durationMs * 0.6;
      var chars = tokens.reduce(function (a, tk) { return a + tk.length + 1; }, 0) || 1;
      var acc = 0;
      for (var q = 0; q < n; q++) {
        var w = tokens[q].length + 1;
        out[q] = { startMs: fStart + ((fEnd - fStart) * acc) / chars, endMs: fStart + ((fEnd - fStart) * (acc + w - 1)) / chars };
        acc += w;
      }
    } else {
      var PER = 280; // ms per unmatched leading/trailing token
      // leading
      var first = anchors[0];
      var lead0 = Math.max(0, out[first].startMs - PER * first);
      fillRange(out, 0, first, lead0, out[first].startMs);
      // gaps between anchors
      for (var a = 0; a + 1 < anchors.length; a++) {
        var lo = anchors[a], hi = anchors[a + 1];
        if (hi - lo > 1) fillRange(out, lo + 1, hi, out[lo].endMs, out[hi].startMs);
      }
      // trailing
      var last = anchors[anchors.length - 1];
      var tailCount = n - 1 - last;
      if (tailCount > 0) fillRange(out, last + 1, n, out[last].endMs, Math.min(hardEnd, out[last].endMs + PER * tailCount));
    }
    for (var z = 0; z < n; z++) {
      var o = out[z];
      var st = Math.min(Math.max(0, o.startMs), hardEnd);
      out[z] = { startMs: st, endMs: Math.min(Math.max(st, o.endMs), hardEnd) };
      if (z > 0 && out[z].startMs < out[z - 1].startMs) out[z] = { startMs: out[z - 1].startMs, endMs: Math.max(out[z - 1].startMs, out[z].endMs) };
    }
    return out;
  }

  function fillRange(out, from, to, startMs, endMs) {
    var count = to - from;
    if (count <= 0) return;
    var span = Math.max(0, endMs - startMs);
    for (var i = 0; i < count; i++) {
      out[from + i] = { startMs: startMs + (span * i) / count, endMs: startMs + (span * (i + 1)) / count };
    }
  }

  /** true for every token covered by one of the highlight phrases (in order, normalized). */
  function highlightMask(tokens, phrases) {
    var norm = tokens.map(normalizeWord);
    var mask = tokens.map(function () { return false; });
    (phrases || []).forEach(function (p) {
      var target = tokenize(p).map(normalizeWord).filter(Boolean);
      if (!target.length) return;
      for (var i = 0; i + target.length <= norm.length; i++) {
        var ok = true;
        for (var k = 0; k < target.length; k++) if (norm[i + k] !== target[k]) { ok = false; break; }
        if (ok) for (var m = 0; m < target.length; m++) mask[i + m] = true;
      }
    });
    return mask;
  }

  /**
   * Strip position (0..10, 10 = the wrapped 0) of each of n digit columns, most significant
   * first, for a continuous value v. Units turn continuously; column k turns only while all
   * columns below it pass 9→0, like a mechanical counter.
   */
  function odometerPositions(v, n) {
    var out = [];
    for (var i = 0; i < n; i++) {
      var k = n - 1 - i;
      var p10 = Math.pow(10, k);
      if (k === 0) { out.push(v % 10); continue; }
      var lower = v % p10;
      out.push((Math.floor(v / p10) % 10) + (lower > p10 - 1 ? lower - (p10 - 1) : 0));
    }
    return out;
  }

  var pure = {
    odometerPositions: odometerPositions,
    normalizeWord: normalizeWord,
    tokenize: tokenize,
    cueStart: cueStart,
    scheduleEntries: scheduleEntries,
    typingSchedule: typingSchedule,
    highlightMask: highlightMask,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = pure;
    return;
  }

  // ── browser timeline ────────────────────────────────────────────────────────

  var STAGE_W = 1920, STAGE_H = 1080;
  var anims = [];
  var seekFns = [];
  var EASE = "cubic-bezier(.2,.7,.2,1)";

  /** A paused Web Animation positioned only by __seek. start/duration in beat ms. */
  function animate(el, keyframes, opts) {
    opts = opts || {};
    var a = el.animate(keyframes, {
      duration: Math.max(1, opts.duration != null ? opts.duration : 500),
      delay: Math.max(0, opts.start || 0),
      fill: "both",
      easing: opts.easing || EASE,
    });
    a.pause();
    a.currentTime = 0;
    anims.push(a);
    return a;
  }

  function onSeek(fn) { seekFns.push(fn); }

  function el(tag, cls, parent, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = String(text);
    if (parent) parent.appendChild(e);
    return e;
  }

  /** Shrink el's font-size (px) until it fits maxW×maxH. Deterministic: fonts are loaded first. */
  function fitText(node, startPx, minPx, maxW, maxH) {
    var px = startPx;
    node.style.fontSize = px + "px";
    while (px > minPx && (node.scrollWidth > maxW + 0.5 || node.scrollHeight > maxH + 0.5)) {
      px -= 2;
      node.style.fontSize = px + "px";
    }
    return px;
  }

  /** Wrap each rendered line of node's word spans in .line > .line-inner (for masked line reveals). */
  function splitLines(node) {
    var words = Array.prototype.slice.call(node.querySelectorAll(":scope > .word"));
    var lines = [];
    var top = null;
    words.forEach(function (w) {
      if (top === null || Math.abs(w.offsetTop - top) > 2) { lines.push([]); top = w.offsetTop; }
      lines[lines.length - 1].push(w);
    });
    node.textContent = "";
    return lines.map(function (ws) {
      var line = el("div", "line", node);
      var inner = el("div", "line-inner", line);
      inner.textContent = ws.map(function (w) { return w.textContent; }).join(" ");
      return inner;
    });
  }

  function wordSpans(node, text) {
    node.textContent = "";
    tokenize(text).forEach(function (t, i) {
      if (i) node.appendChild(document.createTextNode(" "));
      el("span", "word", node, t);
    });
  }

  function fitStage() {
    var stage = document.getElementById("stage");
    var s = Math.min(window.innerWidth / STAGE_W, window.innerHeight / STAGE_H);
    stage.style.transform = "translate(-50%, -50%) scale(" + s + ")";
  }

  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
  function easeOutCubic(x) { x = clamp01(x); return 1 - Math.pow(1 - x, 3); }
  function easeInOut(x) { x = clamp01(x); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; }

  /**
   * Cut-out product centred in box {cx, cy, w, h}, with a floor shadow under what the image
   * actually draws and a gentle float. Returns the element to animate an entry on (entry),
   * the img (for filters) and the drawn rect in stage px (for callout anchors).
   */
  async function product(parent, src, box, opts) {
    opts = opts || {};
    var shadow = el("div", "abs floor-shadow", parent);
    var floatEl = el("div", "abs", parent);
    floatEl.style.left = (box.cx - box.w / 2) + "px"; floatEl.style.top = (box.cy - box.h / 2) + "px";
    floatEl.style.width = box.w + "px"; floatEl.style.height = box.h + "px";
    var entry = el("div", "", floatEl);
    entry.style.width = "100%"; entry.style.height = "100%";
    var img = el("img", "prod-img", entry);
    img.src = src;
    await img.decode();
    var ar = img.naturalWidth / Math.max(1, img.naturalHeight);
    var dw = Math.min(box.w, box.h * ar), dh = Math.min(box.h, box.w / ar);
    var sw = dw * 0.78;
    shadow.style.width = sw + "px";
    shadow.style.left = (box.cx - sw / 2) + "px";
    shadow.style.top = (box.cy + dh / 2 + (opts.shadowGap != null ? opts.shadowGap : 40)) + "px";
    if (opts.noShadow) shadow.style.display = "none";
    var amp = opts.float != null ? opts.float : 9;
    onSeek(function (ms) {
      var s = Math.sin((2 * Math.PI * ms) / 4400);
      floatEl.style.transform = "translateY(" + (s * -amp).toFixed(3) + "px)";
      shadow.style.transform = "scaleX(" + (1 + s * 0.05).toFixed(4) + ")";
    });
    return { entry: entry, img: img, shadow: shadow, drawn: { x: box.cx - dw / 2, y: box.cy - dh / 2, w: dw, h: dh } };
  }

  /**
   * Red stamp slammed onto the scene. s = {text, cueWord?}; enters on its cue word, else at
   * opts.start. Position is the stamp's centre in stage px.
   */
  function stamp(parent, s, words, opts) {
    var node = el("div", "stamp" + (opts.small ? " small" : ""), parent, s.text);
    node.style.whiteSpace = "pre-line";
    if (opts.maxWidth) node.style.maxWidth = opts.maxWidth + "px";
    var w = node.offsetWidth, h = node.offsetHeight;
    node.style.left = (opts.x - w / 2) + "px";
    node.style.top = (opts.y - h / 2) + "px";
    var r = opts.rotate != null ? opts.rotate : -7;
    var cued = s.cueWord ? cueStart(s.cueWord, words) : null;
    var start = cued != null ? cued : opts.start || 0;
    animate(node, [
      { opacity: 0, transform: "rotate(" + r + "deg) scale(1.8)" },
      { opacity: 1, transform: "rotate(" + r + "deg) scale(0.93)", offset: 0.7 },
      { opacity: 1, transform: "rotate(" + r + "deg) scale(1)" },
    ], { start: start, duration: 300, easing: "cubic-bezier(.4,0,.8,1)" });
    return node;
  }

  /**
   * Mechanical odometer rolling from `from` to `to` (integers). Each digit column is a strip
   * 0–9,0; the units roll continuously and a higher column only turns while every column
   * below it is passing 9→0 — so the final frame shows exactly `to`, with leading zeros
   * kept during the roll the way the reference does.
   */
  function odometer(parent, opts) {
    var to = Math.max(0, Math.round(opts.to)), from = Math.max(0, Math.round(opts.from || 0));
    var n = Math.max(String(to).length, String(from).length, opts.minDigits || 1);
    var sep = opts.sep == null ? "," : opts.sep;
    var wrap = el("span", "odo" + (opts.cls ? " " + opts.cls : ""), parent);
    var strips = [];
    for (var i = 0; i < n; i++) {
      var k = n - 1 - i;
      var col = el("span", "odo-col", wrap);
      var strip = el("span", "odo-strip", col);
      for (var d = 0; d <= 10; d++) el("span", "odo-d", strip, String(d % 10));
      strips.push({ k: k, strip: strip });
      if (sep && k > 0 && k % 3 === 0) el("span", "odo-sep", wrap, sep);
    }
    var start = opts.start || 0, dur = Math.max(1, opts.duration || 2000);
    onSeek(function (ms) {
      var pos = odometerPositions(from + (to - from) * easeOutCubic((ms - start) / dur), n);
      for (var s = 0; s < strips.length; s++) {
        strips[s].strip.style.transform = "translateY(" + (-pos[s]).toFixed(4) + "em)";
      }
    });
    return wrap;
  }

  async function waitImages() {
    var imgs = Array.prototype.slice.call(document.images);
    await Promise.all(imgs.map(function (img) {
      if (img.complete && img.naturalWidth) return Promise.resolve();
      return img.decode().catch(function () {
        throw new Error("image failed to load: " + String(img.src).slice(0, 120));
      });
    }));
  }

  function seek(ms) {
    ms = Math.max(0, Number(ms) || 0);
    for (var i = 0; i < anims.length; i++) anims[i].currentTime = ms;
    for (var k = 0; k < seekFns.length; k++) seekFns[k](ms);
    return ms;
  }

  root.GR = Object.assign({}, pure, {
    animate: animate,
    onSeek: onSeek,
    el: el,
    fitText: fitText,
    splitLines: splitLines,
    wordSpans: wordSpans,
    product: product,
    stamp: stamp,
    odometer: odometer,
    clamp01: clamp01,
    easeOutCubic: easeOutCubic,
    easeInOut: easeInOut,
    EASE: EASE,
  });

  root.__setup = async function (data, theme, words, opts) {
    opts = opts || {};
    var durationMs = Math.max(1, Number(opts.durationMs) || 6000);
    document.body.setAttribute("data-theme", theme || "arden");
    document.body.classList.add("bg-" + ((data && data.bg) || "dark"));
    fitStage();
    await Promise.all([
      document.fonts.load('600 100px "Oswald"'),
      document.fonts.load('italic 400 40px "EB Garamond"'),
      document.fonts.load('400 40px "EB Garamond"'),
      document.fonts.load('500 20px "JetBrains Mono"'),
    ]);
    await document.fonts.ready;
    if (!root.__template || typeof root.__template.setup !== "function") throw new Error("template did not register window.__template");
    await root.__template.setup(document.getElementById("stage"), data || {}, {
      durationMs: durationMs,
      words: Array.isArray(words) ? words : [],
    });
    await waitImages();
    seek(0);
    return { ok: true, animations: anims.length };
  };

  root.__seek = seek;
})(typeof window !== "undefined" ? window : globalThis);
