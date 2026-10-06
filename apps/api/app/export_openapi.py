"""Write the OpenAPI contract to a file: `python -m app.export_openapi <path>`.

The committed copy (packages/api-types/openapi.json) is the contract the frontend types are
generated from; CI fails if it drifts.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from app.main import create_app


def main(path: str) -> None:
    spec = create_app().openapi()
    Path(path).write_text(json.dumps(spec, indent=2, sort_keys=True) + "\n")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "openapi.json")
