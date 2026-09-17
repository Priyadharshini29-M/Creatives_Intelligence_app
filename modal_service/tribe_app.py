"""Modal deployment of facebook/tribev2 — the platform's only video-analysis
model. This is the sole place TRIBE v2 inference and its trained head run;
`apps/ai` only ever calls the `analyze_video` method below and gets back the
final analytics dict, never raw model internals.

Deploy:
    modal deploy modal_service/tribe_app.py

One-off smoke test:
    modal run modal_service/tribe_app.py

Required setup (see README.md in this folder for the full walkthrough):
  - A Modal account + `modal token set` run locally.
  - A Modal secret named "huggingface-secret" with an HF_TOKEN that has
    accepted the LLaMA 3.2 license on Hugging Face (TRIBE v2 uses LLaMA 3.2
    internally as its text feature extractor).
  - Nothing else to train the head yet — until apps/ai/scripts/train_tribe_head.py
    has been run and its output uploaded to the "tribe-v2-cache" volume at
    head/head.pt, `analyze_video` returns calibrated: false with untrained
    (meaningless) scores. That is expected, not a bug.
"""

import os
import tempfile

import modal

APP_NAME = "tribe-v2-inference"
CACHE_DIR = "/cache"
HEAD_WEIGHTS_REMOTE_PATH = f"{CACHE_DIR}/head/head.pt"

# add_local_dir resolves relative paths against the CWD `modal deploy` is run
# from, not this file's location — use an absolute path so deploys work
# regardless of where they're invoked from.
_TRIBE_HEAD_DIR = os.path.normpath(
    os.path.join(os.path.dirname(__file__), "..", "packages", "tribe-head")
)

app = modal.App(APP_NAME)

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git", "ffmpeg")
    .pip_install(
        "torch>=2.5.1,<2.7",
        "torchvision",
        "transformers",
        "einops",
        "x_transformers",
        "moviepy",
        "soundfile",
        "gtts",
        "pyyaml",
        "spacy",
        "langdetect",
        "numpy==2.2.6",
        "huggingface_hub",
        "httpx",
    )
    .pip_install("git+https://github.com/facebookresearch/tribev2.git")
    # The trainable head lives in packages/tribe-head so the exact same
    # architecture is used here and in the local training script.
    .add_local_dir(_TRIBE_HEAD_DIR, remote_path="/root/tribe-head", copy=True)
    .run_commands("pip install -e /root/tribe-head")
)

cache_volume = modal.Volume.from_name(f"{APP_NAME}-cache", create_if_missing=True)
hf_secret = modal.Secret.from_name("huggingface-secret")


@app.cls(
    image=image,
    gpu="A10G",
    volumes={CACHE_DIR: cache_volume},
    secrets=[hf_secret],
    timeout=900,
    scaledown_window=300,
)
class TribeV2Model:
    @modal.enter()
    def load(self):
        os.environ.setdefault("HF_HOME", f"{CACHE_DIR}/hf")
        os.makedirs(f"{CACHE_DIR}/features", exist_ok=True)

        from tribev2 import TribeModel

        self.model = TribeModel.from_pretrained(
            "facebook/tribev2",
            cache_folder=f"{CACHE_DIR}/features",
            device="auto",
        )

    def _download(self, source_url: str) -> str:
        import httpx

        suffix = os.path.splitext(source_url.split("?")[0])[1] or ".mp4"
        fd, tmp_path = tempfile.mkstemp(suffix=suffix)
        os.close(fd)
        with httpx.stream("GET", source_url, timeout=180.0) as resp:
            resp.raise_for_status()
            with open(tmp_path, "wb") as f:
                for chunk in resp.iter_bytes():
                    f.write(chunk)
        return tmp_path

    def _predict_vertices(self, source_url: str):
        tmp_path = self._download(source_url)
        try:
            events = self.model.get_events_dataframe(video_path=tmp_path)
            preds, segments = self.model.predict(events=events, verbose=False)
            return preds, segments
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass

    @modal.method()
    def analyze_video(self, source_url: str) -> dict:
        """Full pipeline: TRIBE v2 inference + the trained head. Returns the
        exact analytics dict apps/ai serves to the product — see
        tribe_head.postprocess.analyze for the field contract."""
        from tribe_head import analyze as head_analyze

        preds, segments = self._predict_vertices(source_url)
        weights_path = (
            HEAD_WEIGHTS_REMOTE_PATH
            if os.path.exists(HEAD_WEIGHTS_REMOTE_PATH)
            else None
        )
        return head_analyze(preds, segments, weights_path)

    @modal.method()
    def extract_features(self, source_url: str) -> dict:
        """Raw TRIBE v2 output with no head applied — used by the training
        script to build a labeled feature cache."""
        from tribe_head import normalize_segments

        preds, segments = self._predict_vertices(source_url)
        norm = normalize_segments(segments)
        return {
            "vertices": preds.tolist(),
            "segments": [
                {"start": s.start_sec, "duration": s.duration_sec} for s in norm
            ],
        }


@app.local_entrypoint()
def main(source_url: str):
    """`modal run modal_service/tribe_app.py --source-url <presigned-url>`"""
    result = TribeV2Model().analyze_video.remote(source_url)
    print(result)
