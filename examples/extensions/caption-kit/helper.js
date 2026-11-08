/* caption-kit: word timing helpers for caption compositions.
 * Synced to each composition as assets/cuthol-ext-caption-kit.js and
 * exposed on window.__cuthol.ext["caption-kit"]. Pure functions of (words, t);
 * words are {start, end} in seconds, t is seconds. */
(function (root) {
  var C = root && root.__cuthol ? root.__cuthol : (root.__cuthol = {});
  C.ext = C.ext || {};

  function toNum(v, fallback) {
    var n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  C.ext["caption-kit"] = {
    version: "1.0.0",

    // Index of the word spoken at t, or -1 when none (gap or outside).
    activeWord: function (words, t) {
      if (!Array.isArray(words)) return -1;
      var time = toNum(t, -1);
      if (time < 0) return -1;
      for (var i = 0; i < words.length; i++) {
        var w = words[i] || {};
        var s = toNum(w.start, -1);
        var e = toNum(w.end, -1);
        if (s >= 0 && e > s && time >= s && time < e) return i;
      }
      return -1;
    },

    // Typewriter slice: how many chars of text are visible at t.
    typewriter: function (text, t, cps) {
      var str = String(text === undefined || text === null ? "" : text);
      var rate = toNum(cps, 20);
      if (rate <= 0) return "";
      var n = Math.floor(toNum(t, 0) * rate);
      if (n <= 0) return "";
      return str.slice(0, n);
    },

    // Eased counter 0..target over dur seconds (ease-out cubic).
    counter: function (target, t, dur) {
      var goal = toNum(target, 0);
      var d = toNum(dur, 1);
      var time = toNum(t, 0);
      if (d <= 0) return goal;
      var u = Math.min(1, Math.max(0, time / d));
      var eased = 1 - Math.pow(1 - u, 3);
      return Math.round(goal * eased);
    },
  };
})(typeof window !== "undefined" ? window : globalThis);
