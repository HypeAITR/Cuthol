# Edit dictionary: terms and how each one is done in Cuthol

When someone describes an effect in plain words ("the screen should shake and
flash white into the next scene"), find the term here and use the Cuthol path.
Only paths that exist in Cuthol are listed: a spine/lane command, a HyperFrames
composition on `ln_motion` (see `cuthol-motion`), or FFmpeg preprocessing
before `library.ingest`. If two terms sound alike, the **Tell apart** column
decides; if still unclear, ask which one is meant.

## Transitions

| Term | Plain words | Cuthol path | Tell apart |
|---|---|---|---|
| Match cut | "A shape in one shot continues in the same place in the next" | Hard cut; align both clips with `spine.transform` (x, y, scale); compare both frames with `monitor.frame`. In graphics, match the element position across compositions. | — |
| Zoom transition | "Zoom into the screen and the new scene appears" | `spine.transition(kind="zoom_in")`; a harder version is a composition (zoom blur + white layer). | No animation → punch-in. Inside one clip and blurry → crash zoom. |
| Wipe | "A straight line sweeps the screen into the next scene" | `spine.transition(kind="wipe_left"/"wipe_right")`; other directions in a composition (`clip-path: inset()`). | — |
| Slide / push | "The new scene slides in from the edge and pushes the old one" | `spine.transition(kind="slide_up")`; horizontal push in a composition (two layers, GSAP x). | The picture block stays readable while sliding → slide; blur dominates → whip. |
| Flash (white flash) | "Cut with a white blink" | A composition: white layer opacity 0→1→0 over a few frames, on the beat. Repeated flashes are a photosensitivity risk. | A hard few-frame burst → flash; a soft fade through white → dip (opacity envelope). |
| Iris / shape wipe | "The new scene appears through an opening circle" | A composition: CSS `clip-path: circle()` animated open. | — |
| Clock / radial wipe | "Open like a clock hand sweeping round" | A composition: `conic-gradient` mask, or a custom WebGL shader. | — |
| Split / barn door | "The screen halves open like doors" | A composition: two half-layers, GSAP x in opposite directions. | — |
| Spin transition | "Spin into the next scene" | A composition: GSAP `rotation` + blur. | — |
| Squeeze / stretch | "Squash in one direction, the new one opens out" | A composition: `scaleX`/`scaleY` tween. | — |
| Slice / blinds | "Split into strips that open like blinds" | A composition: N strips, GSAP stagger. | — |
| Cube / 3D spin | "Turn like a cube to the next face" | A composition: CSS `rotateY` + `perspective`. | — |
| Shake transition | "The screen trembles before the cut, then the new scene" | A composition (shake + white flash) with an impact sound on `ln_sfx`. | Hides a cut → shake transition; emphasis inside a clip → camera shake. |
| Colour fade | "Colour drains to grey, cut, colour returns" | A composition: CSS `filter: grayscale()` tween + hard cut. | — |
| Static / TV noise | "Cut through TV static" | A composition: noise shader + a static sound on `ln_sfx`. | — |
| Ink / matte | "The new scene opens as if ink is spreading" | A composition: CSS `mask-image` animated open. | — |
| Bounce transition | "The new scene drops in and bounces into place" | A composition: GSAP `bounce.out` / `elastic.out`. | — |
| Luma fade | "Dark areas dissolve first, the new scene emerges from them" | A composition with a custom brightness-keyed shader. No ready-made path. | — |
| Light leak | "Soft coloured light seeps in from the corner" | A composition: gradient overlay layer. | Covers the screen → film burn; partial and soft → light leak. |
| Warp | "Bend through like a water drop / vortex" | A composition with a custom distortion shader. No ready-made path. | — |

Cuthol transitions are video-only: spine audio hard-cuts at the boundary. A
whole-video pace change (e.g. delivering at 1.1x) has no in-app path: render,
then re-encode outside (`setpts`, `atempo`) and re-check loudness on the
delivered file.

## Camera, motion, speed

| Term | Plain words | Cuthol path | Tell apart |
|---|---|---|---|
| Punch-in | "Suddenly closer here" (no animation) | `spine.envelope` on `placement.scale_x` + `placement.scale_y` together, two points 1 frame apart (e.g. 100→115). Or `spine.split` the clip and `spine.transform(scale="1.15")` on the second piece. | — |
| Ken Burns | "The photo slowly pushes in and drifts" | `spine.envelope` (`scale_x` + `scale_y` + `x_pct`); both scale params are required. | One flat plane → Ken Burns; foreground and background at different speeds → parallax (two layers). |
| Speed ramp | "Normal first, then gradually faster/slower" | `cuthol spine speed --clip sp_XX --ramp "0s:1,3s:3"` (points in source time, linear between them; picture, audio and transcript follow). Pitch protection is on by default; keep ramps within 0.5–2.0 on speech (G410 outside). | Locked to music and repeating → velocity edit. |
| Velocity edit | "Speed up and slow down on the music beat, repeating every beat" | Read beats with `library.beats`, put `spine.speed` `--ramp` points between beats (slow on the beat, fast between). | — |
| Crash zoom | "Rush in, blurring" | `spine.envelope` scale over a few frames + a blur layer in a composition, with a whoosh on `ln_sfx`. | — |
| Camera shake | "The screen jolts at the impact" | `x_pct`/`y_pct` envelope points, or a shake layer in a composition. | Almost invisible mechanical drift → gate weave (tiny random offsets in a composition). |
| Stabilization | "Fix the shaky camera" | FFmpeg preprocessing (`vidstabdetect` + `vidstabtransform`, two passes), then ingest. | — |
| Optical flow | "Don't stutter when slowed down, stay fluid" | FFmpeg `minterpolate` preprocessing (slow, can smear edges). | — |
| Easing | "Start slow and stop gently" | `spine.envelope(..., easing=...)` (`linear`, `ease_in`, `ease_out`, `ease_in_out`, `cubic-bezier(x1,y1,x2,y2)`, `hold`); in compositions GSAP eases. | — |
| Hold keyframe | "Value stays put, then jumps at once" | Envelope `easing="hold"`, or two envelope points 1 frame apart; in compositions GSAP `steps()`. | — |
| Auto reframe | "Turn horizontal video vertical, follow the person" | `spine.reframe` (horizontal tracking, one subject). | — |
| Rate stretch | "The clip slows down as it gets longer" | `spine.speed`. | — |
| Freeze frame | "The picture stops here, text comes over it" | No single command: hold a still of the frame (export the frame, ingest, `spine.append`) with titles over it. | — |

## Text and typography

| Term | Plain words | Cuthol path | Tell apart |
|---|---|---|---|
| Kinetic type | "Spoken words appear one by one, growing and sliding with emphasis" | A composition: word times via `C.word` + GSAP. | — |
| Typewriter | "Typed letter by letter like a typewriter" | A composition: reveal characters on a timer (`C.value`), with a typing sound on `ln_sfx`. | Letters pop at once → typewriter; letters fade softly one by one → stagger. |
| Word-by-word captions | "Subtitles show one word at a time" | `speech.captions(max_words=1)`. | One word on screen → word-by-word; the line stays and the spoken word highlights → karaoke. |
| Karaoke highlight | "The line stays, the spoken word changes colour" | `speech.captions(style="active_word")`. | — |
| Text mask reveal | "Text slides out from behind an invisible line" | A composition: `overflow:hidden` container + translate the inner text (see `cuthol-motion` for mask rules). | — |
| Text on a path | "Text follows a curved line" | A composition: SVG `<textPath>`. | — |
| Per-character 3D | "Letters flip and fly in 3D one by one" | A composition: split into letters + CSS `rotateX/Y` + `perspective`. | — |
| Credit roll | "Credits scroll bottom to top like a film" | A composition: linear translateY (`ease: "none"`). | — |
| Lower third | "A name/title band at the bottom" | A title cue, or a composition band. | — |
| Pop | "Text pops bigger and settles" | A composition: GSAP `back.out` scale, with a pop sound. | — |
| Counter | "The number climbs fast and lands on target" | A composition: `C.value` driving the number so it lands on the spoken word. | — |
| Stagger | "Lines/words arrive one after another" | A composition: GSAP `stagger`. | — |

## Composite, mask, tracking

| Term | Plain words | Cuthol path |
|---|---|---|
| Chroma key | "Remove the green screen, put something behind" | FFmpeg `chromakey` (+ `despill`) preprocessing, then ingest. Never key inside an overlay. |
| Track matte | "Video visible only inside the text/shape" | A composition: CSS `mask-image` or `background-clip:text`. |
| Luma key | "Drop the white background, keep the dark lines" | FFmpeg `lumakey` preprocessing; in a composition `mix-blend-mode: multiply`. |
| Unmult | "Lay a black-background smoke/spark effect over the picture" | A composition: `mix-blend-mode: screen`. |
| Clone | "The same person twice in one frame" | Locked camera + two takes: two `<video>` layers in a composition with a vertical `clip-path` split. |
| Corner pin (static) | "Fit another picture onto the TV screen" | Locked camera: CSS `matrix3d` in a composition, or FFmpeg `perspective` preprocessing. Moving camera: no path. |
| Face tracking | "Keep the face fixed in frame" | Partial: `spine.reframe` follows one person horizontally. Point/planar tracking: no path, keyframe by hand. |
| Rotoscoping / object removal | "Cut the person/object out" | No in-app path. Small locked regions: FFmpeg `delogo`. |
| Text behind subject | "The title stays behind the person" | Layer order in a composition: background → text → person (person needs a transparent layer). |

## Colour and look

| Term | Plain words | Cuthol path |
|---|---|---|
| LUT | "Apply this colour mood in one go" | `cuthol spine grade --clip sp_XX --lut <project-relative .cube/.3dl>`; animated colour via `cuthol spine envelope --param treatments.color_grade.saturation` etc. |
| Lift / gamma / gain, teal & orange, split toning, secondary grading, faded film | "Shadows blue, highlights warm", "cinema teal-orange", "another colour for shadows vs highlights", "change only the sky", "lifted blacks, vintage" | FFmpeg preprocessing (`colorbalance`, `selectivecolor`, `curves`), then ingest; check with `monitor.frame`. |
| Vignette | "Darken the edges" | A composition: `radial-gradient` overlay layer. |
| Bloom | "Bright areas bleed softly outward" | A composition: blurred copy + `screen`. |
| Glow | "Text/lines shine like neon" | CSS `text-shadow` / `drop-shadow` in a composition or title styling. |
| Gate weave / flicker | "Wobble and shimmer like an old projector" | A composition: ±0.25–0.5 px offsets + opacity flicker. |
| Chromatic aberration | "Red-blue fringing at the edges" | FFmpeg `rgbashift` preprocessing. |

## Edit language and rhythm

| Term | Plain words | Cuthol path |
|---|---|---|
| J-cut | "The next scene's sound starts before its picture" | Voiceover on `ln_vo`: put the picture cut a few hundred ms after the voice starts. Spine audio: `library.detach_audio`, slip the audio cue earlier. |
| L-cut | "The picture changes but the previous sound lingers" | Reverse of J-cut: the audio cue runs past the cut. |
| Sound bridge | "One sound connects two scenes" | Run an `ln_sfx`/`ln_bgm` cue across the cut, `anchor`ed. Dialogue over a few frames → J-cut; seconds of music/ambience → bridge. |
| Smash cut | "Cut from loud to sudden silence" (or reverse) | Hard cut + cut the audio sharply too; no transition. Different scenes in contrast → smash; a time jump within one shot → jump cut (use `speech.cleanup`). |
| Cutaway / reaction | "Briefly show a detail / the listener's reaction" | `lane.add_cue(lane="ln_broll", anchor=...)`, 1–1.5 s for reactions. |
| Cross-cutting | "Go back and forth between two events" | `spine.reorder` into alternating order. |
| Invisible editing | "Cuts should not be felt" | Hard cuts + J/L; no showy transitions. |
| Eye-trace | "After the cut the eye looks at the same spot" | Align the new shot's point of interest with the old one's (`spine.transform` x/y). |
| Show, don't tell | "What is said appears on screen at once" | Tie the element to the word time (`C.word` in compositions; captions sit under speech). |

## Sound design

| Term | Plain words | Cuthol path |
|---|---|---|
| Ducking | "Music drops while talking" | `mix.duck` (see `cuthol-audio`). |
| SFX-hit ducking | "Music dips briefly at the hit" | An `audio_chain.gain_db` envelope on the `ln_bgm` cue at that moment. |
| Sudden music stop | "Music stops dead before the reveal" | End the `ln_bgm` cue there, or a 50 ms `gain_db` drop. |
| Music prelap | "The new section's music starts before its picture" | Move the music cue before the cut with a fade-in envelope. |
| Loudness matching | "Levels should match" | `mix.normalize(target_lufs=-14)`; re-measure on the rendered file. |
| Dialogue repair | "Clean hum/hiss" | `mix.polish_voice`, or FFmpeg `afftdn` preprocessing. |
| Music muffling / EQ pocket / reverse reverb / tape stop | "Music goes muffled (underwater)", "carve speech frequencies without dropping level", "echo swells into the sound", "music dies as if unplugged" | FFmpeg preprocessing on that music section (`lowpass`, `equalizer`, `areverse`+`aecho` chains, `asetrate`), then swap cues. No in-app filters. |

## Beat-cut craft (measured medians from beat-synced edits)

| Technique | Measured timing | Cuthol path |
|---|---|---|
| Cut on the beat | Within ±1 frame (onsets land closer than the grid) | `spine.split` + `library.beats`; `mix.beat_align(mode="onsets")` snaps closer than grid mode. |
| Beat flash | ~3 frames full white + ~3 frames decay, starting ~1 frame before the beat | White layer in a composition, started 1 frame before the beat. |
| Punch zoom | In ~2 frames (just before the beat), out ~3 frames | `spine.envelope` on `scale_x`+`scale_y` with a `cubic-bezier` easing. |
| Swing / rotation swell | ~1 s | `spine.envelope` on `placement.rotation_deg`. |
| Shake hit | ~0.25 s, ≥3 direction changes, ~40 px at 1080p | `x_pct`/`y_pct` envelope, or a shake layer in a composition. |
| Dip to black | ~2 frames, scene separator (not beat-locked) | `opacity` envelope. |
| Mirrored-edge slide | ~1 s layer, cut 1 frame before the beat | `cuthol spine transform --edge mirror` + an extension transition (`ext:`). |
| Punchy colour | Very high saturation | `cuthol spine grade --saturation` (enveloped or constant) or `--lut`. |
