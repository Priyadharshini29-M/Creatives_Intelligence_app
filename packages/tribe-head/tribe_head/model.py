"""Multi-task head trained on top of TRIBE v2 cortical-activation predictions.

TRIBE v2 (facebook/tribev2) predicts fMRI-style brain activity across ~20k
cortical vertices per time segment — it does not output engagement,
sentiment, or conversion scores. This head is the single learned mapping
from those vertices to every analytics metric the product shows, so the
platform is driven by exactly one model end to end: TRIBE v2 features in,
this head's task outputs out.

The head ships with random weights until trained. Callers must check
whether a weights file was actually loaded (see ``postprocess.analyze``'s
``calibrated`` flag) rather than trust its numbers on their own.
"""

from __future__ import annotations

import torch
from torch import nn

EMOTIONS = (
    "happiness",
    "excitement",
    "trust",
    "fear",
    "confusion",
    "urgency",
    "curiosity",
)

TRIBES = (
    "gen_z",
    "millennials",
    "luxury_buyers",
    "fitness_audience",
    "beauty_audience",
    "tech_audience",
    "impulse_buyers",
)

# TRIBE v2 predictions are offset by the hemodynamic response delay — shift
# segment timestamps back by this to align with the actual video timeline.
HEMODYNAMIC_OFFSET_SEC = 5.0

# Seconds a viewer must survive for the video to count as "hooked" — the
# industry-standard scroll-stop window on short-form platforms.
HOOK_WINDOW_SEC = 3.0


class TribeHead(nn.Module):
    """Shared trunk over per-segment cortical vertices + one head per task."""

    def __init__(self, n_vertices: int, hidden: int = 256):
        super().__init__()
        self.n_vertices = n_vertices
        self.trunk = nn.Sequential(nn.Linear(n_vertices, hidden), nn.ReLU())
        self.emotion_head = nn.Linear(hidden, len(EMOTIONS))
        self.hazard_head = nn.Linear(hidden, 1)
        self.thumb_head = nn.Linear(hidden, 1)
        self.conversion_head = nn.Linear(hidden, 1)
        self.tribe_head = nn.Linear(hidden, len(TRIBES))

    def forward(self, vertices: torch.Tensor) -> dict[str, torch.Tensor]:
        """``vertices``: (n_segments, n_vertices) for one video."""
        z = self.trunk(vertices)
        pooled = z.mean(dim=0)
        return {
            "emotions": torch.softmax(self.emotion_head(z).mean(dim=0), dim=-1),
            "hazard": torch.sigmoid(self.hazard_head(z)).squeeze(-1),
            "thumb_pause": torch.sigmoid(self.thumb_head(z[0])).squeeze(-1),
            "conversion": torch.sigmoid(self.conversion_head(pooled)).squeeze(-1),
            "tribe": torch.softmax(self.tribe_head(pooled), dim=-1),
        }
