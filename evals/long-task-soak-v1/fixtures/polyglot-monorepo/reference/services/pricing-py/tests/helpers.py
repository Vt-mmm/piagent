import json
from pathlib import Path

SERVICE = Path(__file__).resolve().parents[1]
ROOT = SERVICE.parents[1]
CONTRACT_FIXTURES = ROOT / "shared" / "contracts" / "fixtures"


def sample(name):
    with open(CONTRACT_FIXTURES / name, encoding="utf-8") as handle:
        return json.load(handle)
