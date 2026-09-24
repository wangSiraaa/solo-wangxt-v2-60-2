#!/usr/bin/env bash
# Run the service against a real SQLite database file.
set -euo pipefail
cd "$(dirname "$0")/.."
export DATABASE_URL="${DATABASE_URL:-sqlite:///./data/mutex_matrix.db}"
exec python3 -c "
import os, uvicorn
from app.main import create_app
app = create_app(os.environ['DATABASE_URL'])
uvicorn.run(app, host='0.0.0.0', port=int(os.environ.get('PORT', '8000')))
"
