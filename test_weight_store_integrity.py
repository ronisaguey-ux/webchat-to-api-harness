import os
import json
import tempfile
from weight_store import WeightStore, WeightStoreIntegrityError


def main():
    # 1) valid dict loads
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        json.dump({"a": 1}, f)
        p = f.name
    try:
        data = WeightStore(p).open_weight_store()
        assert data == {"a": 1}, f"unexpected data: {data}"
        print("valid ok")
    finally:
        os.unlink(p)

    # 2) valid JSON but not a dict rejects
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        json.dump([1, 2], f)
        p2 = f.name
    try:
        try:
            WeightStore(p2).open_weight_store()
            print("FAIL non-dict accepted")
            return 1
        except WeightStoreIntegrityError as e:
            print("non-dict ok:", e)
    finally:
        os.unlink(p2)

    # 3) symlink rejected by O_NOFOLLOW
    real = tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False)
    json.dump({"x": 1}, real)
    real.close()
    link = real.name + ".link"
    os.symlink(real.name, link)
    try:
        try:
            WeightStore(link).open_weight_store()
            print("FAIL symlink accepted")
            return 1
        except WeightStoreIntegrityError as e:
            print("symlink ok:", e)
    finally:
        os.unlink(link)
        os.unlink(real.name)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
