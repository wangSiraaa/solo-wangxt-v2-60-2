"""Export the OpenAPI specification to openapi.json (run from repo root)."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

from app.main import create_app


def main() -> None:
    # Build the app against a throwaway database so export has no side effects.
    tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
    tmp.close()
    app = create_app(f"sqlite:///{tmp.name}")
    spec = app.openapi()
    out = Path(__file__).resolve().parent.parent / "openapi.json"
    out.write_text(json.dumps(spec, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
