"""Trains tribe_head.TribeHead on real video-outcome labels.

This is the calibration step that makes the TRIBE v2 pipeline's scores mean
something — until this has been run and its output uploaded to the Modal
volume, apps/services/tribe_v2 returns "calibrated": false and the numbers
are from a randomly-initialized head.

Usage
-----
1. Collect a labeled dataset as a JSON list, one row per video, e.g.::

    [
      {
        "source_url": "https://.../video1.mp4",
        "hook_rate": 0.62,          // actual 3s viewer survival, 0-1
        "hold_rate": 0.18,          // actual completion rate, 0-1
        "conversion_score": 0.09,   // actual conversion rate, 0-1
        "emotions": {"happiness": 0.3, "trust": 0.4, ...},   // optional
        "tribe": {"gen_z": 0.6, "millennials": 0.3, ...}     // optional
      },
      ...
    ]

   Labels come from your own analytics (real watch-time / conversion data),
   not from TRIBE v2 — this script fits the head to *your* ground truth.

2. Extract TRIBE v2 features for each video (heavy step, needs the Modal
   deployment from modal_service/ to already be deployed)::

    python -m apps.ai.scripts.train_tribe_head extract --dataset labels.json --cache-dir ./tribe_cache

3. Train the head against the cached features::

    python -m apps.ai.scripts.train_tribe_head train --dataset labels.json --cache-dir ./tribe_cache --out head.pt

4. Upload the trained head so Modal inference picks it up::

    modal volume put tribe-v2-inference-cache ./head.pt head/head.pt

The loss below is a generic starting point (MSE on the scalar targets,
cross-entropy on the distribution targets when provided). Tune it once you
see how well it fits your actual label distribution.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

import numpy as np
import torch
from torch import nn, optim

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from tribe_head import EMOTIONS, TRIBES, TribeHead  # noqa: E402


def _load_dataset(path: str) -> list[dict]:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def cmd_extract(args: argparse.Namespace) -> None:
    """Calls the deployed Modal service to cache raw TRIBE v2 features."""
    import modal

    rows = _load_dataset(args.dataset)
    os.makedirs(args.cache_dir, exist_ok=True)

    cls = modal.Cls.from_name("tribe-v2-inference", "TribeV2Model")
    instance = cls()

    for i, row in enumerate(rows):
        cache_path = os.path.join(args.cache_dir, f"{i}.npz")
        if os.path.exists(cache_path) and not args.overwrite:
            print(f"[{i + 1}/{len(rows)}] cached, skipping")
            continue
        print(f"[{i + 1}/{len(rows)}] extracting {row['source_url']}")
        result = instance.extract_features.remote(row["source_url"])
        vertices = np.asarray(result["vertices"], dtype=np.float32)
        starts = np.asarray([s["start"] for s in result["segments"]], dtype=np.float32)
        durations = np.asarray(
            [s["duration"] for s in result["segments"]], dtype=np.float32
        )
        np.savez(cache_path, vertices=vertices, starts=starts, durations=durations)


def _target_tensor(row: dict, keys: tuple[str, ...], subfield: str) -> torch.Tensor | None:
    values = row.get(subfield)
    if not values:
        return None
    return torch.tensor([float(values.get(k, 0.0)) for k in keys], dtype=torch.float32)


def cmd_train(args: argparse.Namespace) -> None:
    rows = _load_dataset(args.dataset)

    features = []
    for i, row in enumerate(rows):
        cache_path = os.path.join(args.cache_dir, f"{i}.npz")
        if not os.path.exists(cache_path):
            raise FileNotFoundError(
                f"Missing cached features for row {i} ({row.get('source_url')}) — "
                "run the 'extract' subcommand first."
            )
        features.append(np.load(cache_path))

    n_vertices = features[0]["vertices"].shape[1]
    head = TribeHead(n_vertices)
    optimizer = optim.Adam(head.parameters(), lr=args.lr)
    mse = nn.MSELoss()

    head.train()
    for epoch in range(args.epochs):
        total_loss = 0.0
        for row, feat in zip(rows, features):
            vertices = torch.from_numpy(feat["vertices"])
            optimizer.zero_grad()
            out = head(vertices)

            loss = torch.tensor(0.0)
            if "hook_rate" in row:
                loss = loss + mse(
                    1.0 - out["hazard"][0], torch.tensor(float(row["hook_rate"]))
                )
            if "hold_rate" in row:
                loss = loss + mse(
                    1.0 - out["hazard"].mean(), torch.tensor(float(row["hold_rate"]))
                )
            if "conversion_score" in row:
                loss = loss + mse(
                    out["conversion"], torch.tensor(float(row["conversion_score"]))
                )
            emotion_target = _target_tensor(row, EMOTIONS, "emotions")
            if emotion_target is not None:
                loss = loss + mse(out["emotions"], emotion_target)
            tribe_target = _target_tensor(row, TRIBES, "tribe")
            if tribe_target is not None:
                loss = loss + mse(out["tribe"], tribe_target)

            loss.backward()
            optimizer.step()
            total_loss += float(loss.item())

        print(f"epoch {epoch + 1}/{args.epochs} — avg loss {total_loss / len(rows):.4f}")

    torch.save(head.state_dict(), args.out)
    print(f"saved trained head to {args.out}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    p_extract = sub.add_parser("extract", help="Cache raw TRIBE v2 features via Modal")
    p_extract.add_argument("--dataset", required=True)
    p_extract.add_argument("--cache-dir", required=True)
    p_extract.add_argument("--overwrite", action="store_true")
    p_extract.set_defaults(func=cmd_extract)

    p_train = sub.add_parser("train", help="Fit the head against cached features")
    p_train.add_argument("--dataset", required=True)
    p_train.add_argument("--cache-dir", required=True)
    p_train.add_argument("--out", default="head.pt")
    p_train.add_argument("--epochs", type=int, default=50)
    p_train.add_argument("--lr", type=float, default=1e-3)
    p_train.set_defaults(func=cmd_train)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
