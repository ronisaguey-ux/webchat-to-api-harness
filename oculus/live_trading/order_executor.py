import math

def fail_closed_order(price, quantity, kill_switch, min_price=1e-12, max_quantity=1e6):
    if kill_switch.is_triggered():
        raise RuntimeError('kill-switch triggered; order blocked')
    if not math.isfinite(price) or not math.isfinite(quantity):
        raise ValueError('non-finite order price/quantity; fail-closed')
    if price <= min_price or quantity <= 0:
        raise ValueError('non-positive order price/quantity; fail-closed')
    if quantity > max_quantity:
        raise ValueError('quantity exceeds fail-closed limit')
    return _submit_order_to_broker(price, quantity)

def _submit_order_to_broker(price, quantity):
    raise NotImplementedError('bind to broker adapter')
