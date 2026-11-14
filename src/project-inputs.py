# SPDX-License-Identifier: MIT
"""Pin native repository sources and retain their Nix outputs for pnpm."""
import json
import os
from pathlib import Path
import sys
import tempfile
sys.path.insert(0, sys.argv[1])
import project_inputs
_, _, lockfile, state, references, refresh = sys.argv
file, state = Path(lockfile), Path(state)
previous = json.loads(file.read_text()).get('projectInputs', []) if file.exists() else []
requested = json.loads(references)
if requested is None:
    requested = [item['reference'] for item in previous]
pins = project_inputs.pin(requested, previous, refresh == 'true')
state.mkdir(parents=True, exist_ok=True)
views = project_inputs.npm_views(pins, state/'input-roots')
with tempfile.NamedTemporaryFile(mode='w', dir=state, prefix='.input-views-', delete=False) as output:
    temporary = Path(output.name)
    json.dump(views, output, default=str)
try:
    os.replace(temporary, state/'input-views.json')
finally:
    temporary.unlink(missing_ok=True)
print(json.dumps(pins))
