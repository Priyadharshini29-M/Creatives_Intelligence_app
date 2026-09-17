# TRIBE v2 Modal service

Hosts `facebook/tribev2` on Modal GPU infra. This is the platform's only
video-analysis model — see `apps/ai/app/services/tribe_v2/client.py` for the
FastAPI-side caller, and `packages/tribe-head` for the trained head that
turns TRIBE v2's raw brain-activation output into product metrics.

## Prerequisites

1. A Modal account and the CLI authenticated locally:
   ```sh
   pip install modal
   modal token new
   ```
2. Accept the LLaMA 3.2 license on Hugging Face (TRIBE v2 uses it internally
   as a text feature extractor) with the account whose token you'll use, then
   create a Modal secret carrying that token:
   ```sh
   modal secret create huggingface-secret HF_TOKEN=hf_xxx
   ```
3. Also accept the CC-BY-NC-4.0 license terms on
   https://huggingface.co/facebook/tribev2 with that same account.

> **License note:** facebook/tribev2 is CC-BY-NC-4.0 — non-commercial use
> only. Confirm this is acceptable before this powers a paid product feature.

## Deploy

```sh
modal deploy modal_service/tribe_app.py
```

First cold start downloads the ~700MB checkpoint plus LLaMA 3.2 / V-JEPA2 /
Wav2Vec-BERT weights into the `tribe-v2-inference-cache` volume — expect a
slow first call, fast ones after (the volume persists across deploys).

## Smoke test

```sh
modal run modal_service/tribe_app.py --source-url "https://.../some-video.mp4"
```

## Calibrating the head

Until `apps/ai/scripts/train_tribe_head.py` has been run against real labeled
outcomes and its output uploaded to the volume:

```sh
modal volume put tribe-v2-inference-cache ./head.pt head/head.pt
```

`analyze_video` returns `"calibrated": false` and the scores are from a
randomly-initialized head — expected, not a bug. Don't treat those numbers as
real until `calibrated` is `true`.

## GPU sizing

Defaults to `A10G`. If you see CUDA OOM errors on longer videos, bump the
`gpu=` argument in `tribe_app.py` to `"A100"`.
