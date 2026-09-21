import json
import os
import pathlib
import subprocess
import sys
import time


name, *command = sys.argv[1:]
started = time.monotonic()
result = subprocess.run(command, check=False)
measurement = {
    "command": command,
    "elapsed_seconds": round(time.monotonic() - started, 3),
    "exit_code": result.returncode,
}
path = pathlib.Path(os.environ["RUNNER_TEMP"]) / "validation" / f"{name}.json"
path.write_text(json.dumps(measurement, indent=2) + "\n")
sys.exit(result.returncode)
