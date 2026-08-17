import json
import hashlib
from typing import Dict, Any

class GenomeIntegrityError(Exception):
    pass

def canonical_json(genome: Dict[str, Any]) -> str:
    """Return canonical JSON string of genome for signing/hashing, excluding content_hash."""
    # Create a copy without the content_hash field
    data = {k: v for k, v in genome.items() if k != "content_hash"}
    return json.dumps(data, sort_keys=True, separators=(',', ':'))

def validate_genome_bounds(genome: Dict[str, Any]) -> None:
    """Validate that genome values are within acceptable bounds."""
    if 'weights' not in genome:
        raise GenomeIntegrityError("genome missing 'weights' field")
    if not isinstance(genome['weights'], list):
        raise GenomeIntegrityError("'weights' must be a list")
    for w in genome['weights']:
        if not isinstance(w, (int, float)):
            raise GenomeIntegrityError("weights must be numeric")
        if w < -1 or w > 1:
            raise GenomeIntegrityError("weights out of bounds [-1,1]")

def verify_deployment_signature(canonical: str) -> bool:
    """Verify the deployment signature. For demo, accept if OCULUS_DEPLOY_KEY is 'trusted'."""
    import os
    return os.environ.get("OCULUS_DEPLOY_KEY") == "trusted"

def deploy_genome(genome: Dict[str, Any]) -> None:
    """Deploy a genome to live trading after integrity and signature checks."""
    canonical = canonical_json(genome)
    if hashlib.sha256(canonical.encode()).hexdigest() != genome.get("content_hash"):
        raise GenomeIntegrityError("genome hash mismatch")
    validate_genome_bounds(genome)
    if not verify_deployment_signature(canonical):
        raise GenomeIntegrityError("unsigned genome")
    print(f"Deploying genome to live: {canonical}")
