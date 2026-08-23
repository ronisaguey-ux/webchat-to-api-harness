from security.replay_protection import ReplayGuard

SECRET = b'change-me-in-production'
_replay_guard = ReplayGuard(SECRET)

class ReplayAttackError(Exception):
    pass

def submit_order(envelope):
    if not _replay_guard.verify(envelope):
        raise ReplayAttackError('replay or tampered command')
    # Placeholder for actual order execution logic
    return {"status": "accepted", "order": envelope}
