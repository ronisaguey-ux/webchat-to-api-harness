import pytest
import os
import json
import hashlib
from oculus.ga_strategy import deploy_genome, GenomeIntegrityError, canonical_json, validate_genome_bounds, verify_deployment_signature

def test_canonical_json():
    genome = {"weights": [0.1, -0.2], "content_hash": "abc"}
    canon = canonical_json(genome)
    # content_hash is excluded from canonical representation for signing
    assert canon == '{"weights":[0.1,-0.2]}'

def test_validate_genome_bounds_valid():
    genome = {"weights": [0.5, -0.3, 1.0]}
    validate_genome_bounds(genome)  # should not raise

def test_validate_genome_bounds_missing_weights():
    genome = {}
    with pytest.raises(GenomeIntegrityError, match="missing 'weights'"):
        validate_genome_bounds(genome)

def test_validate_genome_bounds_non_list():
    genome = {"weights": "not a list"}
    with pytest.raises(GenomeIntegrityError, match="must be a list"):
        validate_genome_bounds(genome)

def test_validate_genome_bounds_out_of_range():
    genome = {"weights": [1.5, 0.2]}
    with pytest.raises(GenomeIntegrityError, match="out of bounds"):
        validate_genome_bounds(genome)

def test_deploy_genome_success(monkeypatch):
    genome = {"weights": [0.1, -0.2], "content_hash": ""}
    canon = canonical_json(genome)
    genome["content_hash"] = hashlib.sha256(canon.encode()).hexdigest()
    monkeypatch.setenv("OCULUS_DEPLOY_KEY", "trusted")
    deploy_genome(genome)  # should not raise

def test_deploy_genome_hash_mismatch():
    genome = {"weights": [0.1, -0.2], "content_hash": "wrong"}
    with pytest.raises(GenomeIntegrityError, match="hash mismatch"):
        deploy_genome(genome)

def test_deploy_genome_unsigned(monkeypatch):
    genome = {"weights": [0.1, -0.2], "content_hash": ""}
    canon = canonical_json(genome)
    genome["content_hash"] = hashlib.sha256(canon.encode()).hexdigest()
    monkeypatch.delenv("OCULUS_DEPLOY_KEY", raising=False)
    with pytest.raises(GenomeIntegrityError, match="unsigned genome"):
        deploy_genome(genome)
