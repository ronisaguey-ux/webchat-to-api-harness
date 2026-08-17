from typing import List, Dict, Any

class Genome:
    """Simplified genome representation."""
    def __init__(self, weights: List[float], content_hash: str = None):
        self.weights = weights
        self.content_hash = content_hash

    def to_dict(self) -> Dict[str, Any]:
        return {"weights": self.weights, "content_hash": self.content_hash}
