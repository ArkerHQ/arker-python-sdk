#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["arker==0.8.6"]
# ///
"""Build a local React app in an Arker VM and expose it with a policy.

Run from the repository root:

    ARKER_API_KEY=ark_live_... ./examples/react-policy/quick_start.py
"""

from pathlib import Path
from urllib.request import urlopen

from arker import Arker

REGION = "us-west-2"
PROVIDER = "aws"
APP_PORT = 8080
LOCAL_APP = Path(__file__).parent / "app"
REMOTE_APP = "/workspace/react-policy"

BUILD_POLICY = {
    "policies": [
        {
            "type": "outbound",
            "match": {
                "hosts": ["registry.npmjs.org"],
                "ports": [443],
            },
            "action": "allow",
        }
    ]
}

PUBLIC_POLICY = {
    "policies": [
        {
            "type": "inbound",
            "match": {"ports": [APP_PORT]},
            "action": "allow",
            "auth": "open",
        }
    ]
}


def main() -> None:
    arker = Arker(region=REGION, provider=PROVIDER)
    vm = None

    try:
        print("1. Forking ubuntu-full")
        print("   Build policy: allow registry.npmjs.org:443")
        vm = arker.fork(
            "ubuntu-full",
            name="react-policy-demo",
            policies=BUILD_POLICY,
        )
        print(f"   VM: {vm.id}")

        print(f"\n2. Syncing ./app to {REMOTE_APP}")
        vm.sync_dir(str(LOCAL_APP), REMOTE_APP)

        print("\n3. Building the React project on the VM")
        print("   $ npm ci --include=dev --no-audit --no-fund")
        print("   $ npm run build")
        build = vm.run(
            f"""
            set -eu
            cd {REMOTE_APP}
            npm ci --include=dev --no-audit --no-fund
            npm run build
            """
        )
        if build.exit_code != 0:
            raise RuntimeError(build.stderr.decode(errors="replace").strip())

        print(f"\n4. Exposing the app on port {APP_PORT}")
        print(f"   Runtime policy: allow public inbound traffic on :{APP_PORT}")
        print("   $ node server.mjs")
        session = vm.create_session(cwd=REMOTE_APP)
        server = vm.run(
            "exec node server.mjs",
            session_id=session.session_id,
            background=True,
            timeout=0,
            policies=PUBLIC_POLICY,
        )

        # Wait until the server accepts connections before checking it publicly.
        health = vm.run(
            f"curl --retry 10 --retry-connrefused --retry-delay 1 "
            f"-fsS http://127.0.0.1:{APP_PORT}/healthz"
        )
        if health.exit_code != 0:
            raise RuntimeError(health.stderr.decode(errors="replace").strip())

        public_url = f"https://{vm.id}-{APP_PORT}.{PROVIDER}-{REGION}.arker.app"
        print(f"\n5. Verifying {public_url}")
        with urlopen(f"{public_url}/healthz", timeout=10) as response:
            if response.read() != b"ok\n":
                raise RuntimeError(
                    "The public health check returned unexpected content"
                )
        with urlopen(f"{public_url}/", timeout=10) as response:
            if b"<title>Arker React policy demo</title>" not in response.read():
                raise RuntimeError("The public app returned unexpected content")

    except BaseException:
        if vm is not None:
            print(f"\nSetup failed. Deleting {vm.id}...")
            vm.delete()
        raise

    print("\nYour React web app is now running on an Arker VM!\n")
    print(f"App URL: {public_url}")
    print(f"VM:      {vm.id}")
    print(f"Run:     {server.run_id}")
    print(f"Session: {session.session_id}")
    print(f"Delete:  arker rm {vm.id}")


if __name__ == "__main__":
    main()
