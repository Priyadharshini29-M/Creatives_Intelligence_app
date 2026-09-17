# This platform vs. TRIBE v2: what's real, what's derived, what's missing

This document exists to answer one question honestly: **when this platform shows a
score, how much of that number actually came from the TRIBE v2 model, and how much
did we compute ourselves?**

## 1. What TRIBE v2 actually is

`facebook/tribev2` (source: github.com/facebookresearch/tribev2, weights:
huggingface.co/facebook/tribev2, license **CC-BY-NC-4.0 — non-commercial only**) is
a brain-response prediction model. Given video + audio + text, it predicts
activation across ~4,000 fMRI-derived "vertices," grouped into five regions of
interest: language, visual, attention, emotion, and a default-mode network. It does
**not** natively output anything called "hook rate," "scroll-stop probability," or
"conversion score" — those are product concepts, not neuroscience ones. Turning
raw vertex activation into product metrics requires an additional trained mapping
(a "head"), or a hand-built approximation formula.

The model has four input encoders, each a real, separate deep model:

| Modality | Encoder |
|---|---|
| Text | `meta-llama/Llama-3.2-3B` |
| Image/frames | `facebook/dinov2-large` |
| Audio | `facebook/w2v-bert-2.0` |
| Video | `facebook/vjepa2-vitg-fpc64-256` |

## 2. Two ways this platform can call it

### 2a. Currently wired up: third-party text-only demo (what's live today)

`apps/ai/app/services/tribe_v2/client.py` calls a public community Hugging Face
Space (`janrudolph/tribe-v2-api`), not Meta's or our own infrastructure. That Space
only exercises the **text encoder** (Llama-3.2-3B) — it never touches frames,
audio, or the visual/video encoders, despite the model being capable of all four.
It runs on free CPU-only hardware.

**Current live status:** broken. Every request crashes with a dtype bug in the
Space's own code (`float != c10::BFloat16`) — root-caused, a one-line fix was
submitted as a Pull Request
(huggingface.co/spaces/janrudolph/tribe-v2-api/discussions/1), and is awaiting
the Space owner's merge. Until then, every video's TRIBE step fails and the
platform falls back to nulls rather than fabricating numbers.

### 2b. Available but not in use: our own Modal GPU deployment

`modal_service/tribe_app.py` deploys the **full** model (all four encoders, real
video/audio/text input) to a Modal GPU container under this project's own Modal
account. It already exists, is already authenticated, and was working as of its
last recorded use. It was deliberately left switched off in favor of 2a to avoid
GPU billing, since the free option was assumed to be "good enough" — that
assumption turned out to be wrong given how unreliable the free demo has been.

It is **not currently wired into the running pipeline.** `apps/ai` calls 2a, not
this.

## 3. Metric-by-metric: what's real vs. what's ours

"Real" = comes directly from a TRIBE v2 model output. "Derived" = we computed it
with our own fixed-weight formula on top of TRIBE v2 (and, in some cases,
non-TRIBE signals we compute ourselves, like frame motion or audio spikes).
"Unsupported" = this integration cannot produce it under any circumstance today.

| Product metric | Source | Real or derived? | Notes |
|---|---|---|---|
| Attention Capture | TRIBE v2 attention ROI | **Real** (once endpoint works) | Direct model output, hand-normalized 0–100 |
| Emotional Valence | TRIBE v2 emotion ROI | **Real** | Same |
| Overall Brain Engagement | TRIBE v2 default-mode ROI | **Real** | Same |
| Visual Imagery | TRIBE v2 visual ROI | **Real**, but from **text alone** | The text encoder predicts what a *visual* ROI would do in response to the *words*, not from actually watching the video — the current integration never feeds it real frames |
| Hook Rate | `attention×0.4 + motion×0.3 + imagery×0.3` | **Derived** | `motion` is our own frame-diff + audio-spike calculation, not TRIBE v2 output |
| Scroll-Stop Probability | `motion×0.40 + attention×0.40 + imagery×0.20` | **Derived** | Same caveat |
| Conversion Score | `attention×0.35 + emotional×0.20 + engagement×0.25 + motion×0.20` | **Derived** | Same caveat |
| Hold Rate | — | **Unsupported** | No field, no formula, no matter what — would need a per-timestamp retention curve, which a single flat text score structurally cannot produce |
| Avg. Play Time | — | **Unsupported** | Same reason |
| Per-timestamp / temporal attention changes | — | **Unsupported** | No timeline signal from a single text call |
| Scene-level cognitive response | — | **Unsupported** | No scene boundaries without real frame input |
| Cross-modal consistency | — | **Unsupported** | Only text is scored; audio/video are never actually sent to the model in the live path |
| Memory encoding, semantic understanding, cognitive load, information processing | — | **Unsupported** | Not produced by this model at all, real or derived — never fabricated |

The weights in the "Derived" formulas (0.4/0.3/0.3, etc.) are fixed values carried
over from an early reference prototype, not learned from any labeled outcome data.
That's why every result from this path is tagged `calibrated: false` — it's an
honesty flag, not an error state.

## 4. What using the Modal path (2b) would change

If the pipeline were switched to call the Modal deployment instead:

- Frames, audio, and text would all genuinely reach the model — **Visual Imagery**
  would reflect the actual video instead of a text-only guess, and cross-modal
  signal would become genuinely possible (not automatically implemented — would
  require replacing the current formula code, not just swapping the URL).
- The dtype-crash class of bug disappears — it's a CPU-only artifact; GPUs handle
  the model's native precision without it.
- Everything above the "Real" line in the table would improve. Everything in the
  "Unsupported" section stays unsupported unless `packages/tribe-head` is actually
  trained — right now the trained-head weights were never uploaded to Modal
  (`analyze_video` would return `calibrated: false` with an untrained/random head
  if called as-is), so today it would still need the same kind of hand-built
  formula this document describes, just fed with real signal instead of
  text-only signal.
- Runs on billed GPU time under this project's own Modal account instead of a
  free community demo. This was evaluated and **declined** — the platform stays
  on the free path (2a) and depends on the pending community PR being merged.

## 5. License note

`facebook/tribev2` is CC-BY-NC-4.0 — non-commercial use only, for either calling
path. This platform's current use is non-commercial/internal, so this is not a
blocker today — re-check this if the platform's use case changes.

## 6. Closed-loop training: how to actually calibrate the head

This is the recommended path to get genuinely calibrated numbers (as opposed to
the fixed-weight formulas in §3) — teach `packages/tribe-head` what your videos'
*real* performance looks like, instead of guessing with hand-picked weights.

### 6a. Record real outcomes as they come in

Every video's detail page has a **"Record real-world outcome"** card. Pull the
actual numbers from that platform's own analytics once a video has been live
long enough to have them:

| Field | Where to find it |
|---|---|
| Hook rate | YouTube Studio: retention curve, % remaining at 0:03. Meta/Instagram Insights: "Average watch time" 3s+ hook metric. TikTok Analytics: "watched full video" funnel start. |
| Hold rate | YouTube Studio: retention at 100% of duration. Meta/Instagram Insights: completion rate. |
| Conversion score | Whatever your actual funnel calls a conversion — link clicks, sign-ups, purchases attributed to the video — as a fraction of viewers. |

Saved via `PATCH /videos/:id/outcome`, stored in the `VideoOutcome` table
(`packages/database/prisma/schema.prisma`) — real numbers only, never predicted.

### 6b. Export the labeled dataset

Once you've recorded outcomes for a decent number of videos (the more, the
better the head will generalize):

```sh
curl -H "Authorization: Bearer <token>" \
  http://localhost:4000/api/v1/training/export-dataset > labels.json
```

This calls `GET /training/export-dataset` (`apps/api/src/training/`), which pulls
every video in your team that has a recorded outcome and produces exactly the
JSON shape `train_tribe_head.py` expects — presigned download URL plus whichever
of `hook_rate` / `hold_rate` / `conversion_score` you recorded.

**Important:** those presigned URLs point at `S3_ENDPOINT`
(`http://localhost:9000` in local dev) and expire in 1 hour. Modal's remote GPU
container has to be able to download them, so:

- If `S3_ENDPOINT` is still `localhost`, Modal cannot reach it — put a tunnel in
  front of it first (ngrok/cloudflared, the same approach used earlier in this
  project's history for the original Modal integration), or point it at a real
  publicly-reachable bucket.
- Run the `extract` step (next) soon after exporting, before the URLs expire.

### 6c. Extract real TRIBE v2 features via Modal

```sh
python -m apps.ai.scripts.train_tribe_head extract \
  --dataset labels.json --cache-dir ./tribe_cache
```

This calls the already-deployed `tribe-v2-inference` Modal app
(`modal_service/tribe_app.py`) once per video to get real per-segment
brain-activation vertices — the actual model output, not a formula. This is the
"occasional batch cost" that was explicitly approved: billed Modal GPU time,
scoped to your labeled dataset, not to every live video.

### 6d. Train the head

```sh
python -m apps.ai.scripts.train_tribe_head train \
  --dataset labels.json --cache-dir ./tribe_cache --out head.pt
```

Fits `TribeHead` (`packages/tribe-head/tribe_head/model.py`) against your real
labels. More labeled videos and more epochs will generally help; the default
loss (plain MSE) is a reasonable starting point, tune it once you see how it
fits your actual outcome distribution.

### 6e. Deploy the trained head

```sh
modal volume put tribe-v2-inference-cache ./head.pt head/head.pt
```

From this point, calling the Modal path's `analyze_video` returns
`calibrated: true` with scores actually fitted to your audience — a
meaningfully different (and more trustworthy) thing than anything in §3's table.

### What this doesn't solve

The live pipeline still calls the free text-only HF demo (§2a), not Modal —
that decision wasn't changed. This closed loop is ready to use the moment you
decide to switch the live path to Modal (or as a one-off analysis), but doesn't
by itself change what's shown in the product today.
