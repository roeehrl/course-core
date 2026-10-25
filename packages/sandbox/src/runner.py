"""Untrusted execution side only. No expected answers or grader code are mounted here."""
import importlib.util
import json
import sys

# The end of sandbox setup: the host starts the learner's time limit when it reads this line,
# which is written before the submission is loaded (RUNNER_READY_LINE in index.ts). Not graded output.
sys.stdout.write("course-core-sandbox-ready python-json-v1\n")
sys.stdout.flush()
spec = importlib.util.spec_from_file_location("submission", "/work/submission.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
solve = getattr(module, "solve")
for line in sys.stdin:
    request = json.loads(line)
    try:
        result = solve(request["input"])
        print(json.dumps({"id": request["id"], "output": result}, allow_nan=False), flush=True)
    except BaseException as error:
        # This is diagnostic only. The host independently validates every returned value.
        print(json.dumps({"id": request["id"], "error": type(error).__name__}), flush=True)
