# Toolbelt

Local tools for a photographer, as one installable web app. Everything runs on the device; photos never leave it.

**Install on an iPhone:** open the Toolbelt site in Safari, tap Share → **Add to Home Screen**. It opens full-screen and works offline.
**Install on a computer:** Chrome or Edge show an install icon in the address bar on the Toolbelt page.

The site is published from this repository by GitHub Pages (`.github/workflows/pages.yml`). One-time setup: repo **Settings → Pages → Source: GitHub Actions**. The site is then at `https://<owner>.github.io/Toolbelt/`. Each push rebuilds it; installed apps pick the new version up on their next open and offer a reload.

## Layout

- `index.html` — the launcher: lists the modules, registers the offline cache, offers Install.
- `modules/<name>.html` — one self-contained file per module. Add a module: drop the file in `modules/`, add a card to `index.html` and a line to `FILES` in `sw.js`.
- `manifest.webmanifest`, `sw.js`, `icons/` — the app shell. `tools/stamp-sw.mjs` versions the cache from the files' content; `tools/make-icons.mjs` renders the icons.

## Carousel Sequencer

`modules/carousel-sequencer.html` is one self-contained page for cutting a pool of photos down to an Instagram carousel of up to 20 slides. It measures and proposes; it never places, orders or cuts anything without a tap. Rules live in `CLAUDE.md`.

**Open it:** from the Toolbelt launcher (installed app or site), from the published claude.ai link, or by double-clicking the file on a desktop. Photos never leave the device, except the contact sheet that Propose sends when you tap it.

### The three tabs

1. **Cut.** Add the whole pool from Photos or Files, dozens to a couple hundred frames, in any number of batches, or as one **.zip**. A zip keeps the original filenames and works where a picker allows only one pick: in Photos, select them → Share → Save to Files; in Files, long-press the folder → Compress. Frames stay in the order you added them, labelled by file number (`9774`, `103_0216`) and camera.

   Cutting runs as four passes, one decision each, with the count always visible as **kept / target** (default 20, editable):
   - **1 · Flags.** The tool flags a tiny set of *likely cuts*: about 10% of the pool at most, plus the weaker of each tight twin pair. Only compound mechanical signals count: a pocket shot (near-black and flat), nothing in focus on a textured frame, much softer than the other frames from the same camera, screenshot-shaped, a tiny file. Exposure or colour alone never flags. Each flag is a badge with a one-phrase reason; nothing is decided for you. **Out all N flagged** is one tap, with Undo.
   - **2 · Sweep.** Open a frame and swipe: **↑ keep**, **↓ out**, **← →** next and previous. A decision auto-advances. Twins (same camera, near-identical) come one after another; bursts (same camera within 4 s) are noted. **Undo** stays on screen after every decision.
   - **3 · Keep.** Kept frames, with **★ Hero** for the strongest.
   - **4 · Narrow.** The hard part: choosing among frames you like. After measuring, the page reads every frame with a small on-device model (embedded in the file; nothing is fetched or uploaded) and the Narrow panel shows:
     - **Scenes:** the pool grouped by subject, kept frames outlined. One per scene is the editor's rule.
     - **Closest kept pairs:** the kept frames most alike, as a percentage, each with **Compare**. Near-twins by content, including the same subject from another angle.
     - **Coverage pick:** when kept > target, the subset of your kept frames that covers the most ground (heroes always stay). Every proposed drop says which kept frame it is closest to; **Drop** returns it to undecided, never to Out.
     - What the kept set has and lacks: counts by scale, you-in-frame and camera, and gaps such as "no close frames".
     Also **Survey** (the kept set as a grid, tap to drop, long-press for Hero, **Grid size** for the cover test) and **Compare** (kept look-alike pairs two-up: keep left, keep right, or both).
   - Faces are found on-device too (count, size, position). The photo view says "1 face, large" and suggests the You tag; cover candidates include untagged frames with a face and warn when the subject is small at grid size. The model can't tell who a face is; it only suggests.

2. **Sequence.** The carousel as a storyboard. Each row shows the slide's role (Cover; Second cover, where Instagram re-shows the post to people who didn't swipe; Closer), the file number, the camera, and plain-word tags (Scale: Wide, Close, Face, Texture; You: Not in it, Face hidden, Face shown). Reorder with the handle or ↑ ↓. **Pin** a slide to keep it where it is. **Swap** replaces a slide from your kept frames in one tap. **Video slides** count toward the 20 and hold the slot. Between rows you see the brightness change, the colour shift and any camera change (a label, never a warning).

   Every proposal is given by slot number with one reason. Nothing applies until you tap, and pinned slides never move:
   - **Cuts**: a cut list and a keep list on mechanical grounds only: the weaker twin (softer, then more clipped), frames off their camera's baseline, and face-hidden frames of you beyond four. Texture breaks from a second camera are flagged as a pair, to keep both or cut both. **Copy list** copies it as plain lines.
   - **Fix** on a warning: the fewest moves (at most two) that clear it without adding a new warning, each labelled with the rule it serves, applied one at a time.
   - Pacing warnings are about pivots and movement: **flat runs** (three or more slides with no tonal movement) and **no pivot from 1 to 2**. A big jump is never a warning.
   - **Bridge** on a seam: frames from the pool that could sit between the two sides, with a tone between them, a scale unlike both and a camera matching one side.
   - **Cover candidates**: frames tagged with you in frame and not soft, shown at profile-grid thumbnail size.
   - **This post: hold phone frames back as an epilogue**: a switch for this carousel only. When on, a Fix proposes the moves that put them at the end.
   - **Propose with Claude** (only in the claude.ai viewer): sends a small numbered contact sheet, the title and the tags. It gets back an order and cuts by slot number with one-line reasons, using thesis language only when you've given a title. A proposal that moves or cuts a pinned slide is refused. This is the only thing that leaves the device, and only when you tap it.
3. **Preview.** Swipe through the carousel at one ratio, with slide 1 at the profile-grid crop, and adjust each slide's crop. Export renders `NN-<file number>.jpg` at 1080 px wide and skips video slots, telling you where each video goes. Only sequential capture times are written, so Photos keeps the order; there is also an option for no metadata at all.

The carousel (title, decisions, tags, order, crops) autosaves on the device. **Save backup** writes it as a JSON file; adding that file restores it.

### Colour and tone checks

Each frame is compared with **its own camera's** median: the carousel's frames from that camera if there are 3 or more, otherwise that camera's frames not marked Out. A camera with fewer than 3 frames is not judged. Set-wide medians appear in the photo view's Numbers table and are never flagged. RAW files are measured from the camera's embedded preview, which is not your edit, so they get no colour flags and stay out of every baseline.

| metric | definition | flagged when |
|---|---|---|
| saturation | median of per-pixel HSV S | ±0.05 |
| contrast | p95 − p5 of Rec.709 luma | ±0.12 |
| clipped highlights | % of pixels whose brightest channel ≥ 250 | +3 pts and ≥ 2× |
| crushed shadows | % of pixels whose brightest channel ≤ 5 | +3 pts and ≥ 2× |
| warmer / cooler | mean (R−B)/255 over near-neutral pixels | ±0.03 |
| magenta / green | mean (G−(R+B)/2)/255 over near-neutral pixels | ±0.02 |
| soft | variance of the Laplacian | below half the camera median |

### iPhone filenames

Safari 17+ renames picked photos to `tempImage….heic` (and converts them) when a page asks for HEIC, so the page never asks for HEIC. If the picker still renames anything, the page names the affected files. Re-add them with the picker's **Options → Format: Current**, or through **Add from Files**.

### Tests

```
npm test            # core: metrics, per-camera flags, likely cuts, bursts, twins/rhymes, file numbers, EXIF, RAW, zip, crop maths
npm run smoke       # drives the page in Chromium: cut → sequence (video, swap, pin, fix, cuts, bridge, cover, propose) → export → reload
npm run scale       # 200 full-size frames on an emulated iPhone: load, measure, scene-reading and tap timings
npm run calibrate   # radar station set: put the exports in tests/fixtures/radar-station/
```

### On-device AI

`tools/embed-ai.mjs` embeds TensorFlow.js (from cdnjs) and two small models from TF Hub into `modules/carousel-sequencer.html`, MobileNetV2-0.35 feature vectors (scene embeddings) and BlazeFace (faces), into the page as inline script and base64 weights: about 4.2 MB. They load from memory with `tf.io.fromMemory`, so the page never fetches anything at runtime and photos never leave the device. Subject size comes from spectral-residual saliency in plain JS. Scene reading starts once measuring has finished and is cached alongside the metrics. If the models fail to load (an old browser), everything else still works. Re-run the script to refresh the embedded files.

Not in v1: exporting or measuring video, and the bridge to the zine site's JSON import.
