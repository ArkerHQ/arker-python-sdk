"""Cross-language parity test for a running Arker Kernel proxy.

Install `kernel==0.86.0`, then provide KERNEL_BASE_URL, KERNEL_API_KEY, and
KERNEL_SESSION_ID. The test preserves the supplied browser.
"""
import asyncio
import base64
import io
import os
import time
import uuid

from kernel import AsyncKernel, Kernel


BROWSER_ID = os.environ["KERNEL_SESSION_ID"]
BASE_URL = os.environ["KERNEL_BASE_URL"]
API_KEY = os.environ["KERNEL_API_KEY"]


def decoded(value: str | None) -> bytes:
    return base64.b64decode(value or "")


client = Kernel(api_key=API_KEY, base_url=BASE_URL, timeout=180.0, max_retries=0)
resource_suffix = uuid.uuid4().hex[:8]
resource_profile_id = None
resource_extension_id = None
resource_proxy_id = None
extension_archive = base64.b64decode(
    "UEsDBBQAAAAIAHOqBV060pKOQQAAAEYAAAANAAAAbWFuaWZlc3QuanNvbqtWyk3My0xLLS6JL0stKs7Mz1OyMtZRykvMTVWyUnIsyk4tUvBOLcpLzVFwy6woKS1KVdJRgqtUMtQz0DNQqgUAUEsBAhQDFAAAAAgAc6oFXTrSko5BAAAARgAAAA0AAAAAAAAAAAAAAIABAAAAAG1hbmlmZXN0Lmpzb25QSwUGAAAAAAEAAQA7AAAAbAAAAAAA"
)
try:
    resource_profile = client.profiles.create(name=f"python-profile-{resource_suffix}")
    resource_profile_id = resource_profile.id
    assert client.profiles.retrieve(resource_profile.id).id == resource_profile.id
    assert any(item.id == resource_profile.id for item in client.profiles.list(name=resource_profile.name))
    assert client.profiles.download(resource_profile.id, format="tar").read() == b""

    resource_extension = client.extensions.upload(
        name=f"python-extension-{resource_suffix}", file=("extension.zip", io.BytesIO(extension_archive), "application/zip")
    )
    resource_extension_id = resource_extension.id
    assert client.extensions.get(resource_extension.id).checksum == resource_extension.checksum
    assert client.extensions.download(resource_extension.id).read() == extension_archive

    resource_proxy = client.proxies.create(
        type="custom",
        name=f"python-proxy-{resource_suffix}",
        protocol="http",
        config={"host": "proxy.example.invalid", "port": 8080, "username": "python", "password": "secret"},
    )
    resource_proxy_id = resource_proxy.id
    assert resource_proxy_id and client.proxies.retrieve(resource_proxy_id).id == resource_proxy_id
    assert resource_proxy.config.has_password is True
finally:
    if resource_proxy_id:
        client.proxies.delete(resource_proxy_id)
    if resource_extension_id:
        client.extensions.delete(resource_extension_id)
    if resource_profile_id:
        client.profiles.delete(resource_profile_id)

browser = client.browsers.retrieve(BROWSER_ID)
assert browser.session_id == BROWSER_ID
assert any(item.session_id == BROWSER_ID for item in client.browsers.list(limit=100))

completed = client.browsers.process.exec(
    BROWSER_ID,
    command="python3",
    args=["-c", "import os; print(os.environ['PY_PARITY'], end='')"],
    env={"PY_PARITY": "python-ok"},
)
assert completed.exit_code == 0 and decoded(completed.stdout_b64) == b"python-ok"

spawned = client.browsers.process.spawn(
    BROWSER_ID,
    command="bash",
    args=["-lc", "sleep 0.25; printf python-spawn"],
    timeout_sec=10,
)
for _ in range(50):
    status = client.browsers.process.status(spawned.process_id, id=BROWSER_ID)
    if status.state == "exited":
        break
    time.sleep(0.1)
assert status.state == "exited" and status.exit_code == 0
streamed = b"".join(
    decoded(event.data_b64)
    for event in client.browsers.process.stdout_stream(spawned.process_id, id=BROWSER_ID)
    if event.data_b64
)
assert streamed == b"python-spawn"

root = "/tmp/kernel-python-live"
try:
    client.browsers.fs.delete_directory(BROWSER_ID, path=root)
except Exception:
    pass
client.browsers.fs.create_directory(BROWSER_ID, path=root, mode="0750")
client.browsers.fs.write_file(BROWSER_ID, b"python filesystem", path=f"{root}/input.txt")
assert client.browsers.fs.read_file(BROWSER_ID, path=f"{root}/input.txt").read() == b"python filesystem"
assert client.browsers.fs.file_info(BROWSER_ID, path=f"{root}/input.txt").size_bytes == 17
assert any(item.name == "input.txt" for item in client.browsers.fs.list_files(BROWSER_ID, path=root))

playwright = client.browsers.playwright.execute(
    BROWSER_ID,
    code="await page.goto('https://example.com'); return await page.title();",
)
assert playwright.success is True and playwright.result == "Example Domain"
curl = client.browsers.curl(BROWSER_ID, url="https://example.com", response_encoding="utf8")
assert curl.status == 200 and "Example Domain" in curl.body
direct = client.browsers.request(BROWSER_ID, "GET", "https://example.com")
assert direct.status_code == 200 and "Example Domain" in direct.text

echo_server = client.browsers.process.spawn(
    BROWSER_ID,
    command="node",
    args=["-e", "require('http').createServer((req,res)=>{const chunks=[];req.on('data',chunk=>chunks.push(chunk));req.on('end',()=>res.end(Buffer.concat(chunks)))}).listen(18766,'127.0.0.1')"],
    timeout_sec=120,
)
try:
    for _ in range(30):
        ready = client.browsers.process.exec(
            BROWSER_ID,
            command="bash",
            args=["-lc", "if curl -fsS http://127.0.0.1:18766 -o /dev/null 2>/dev/null; then printf ready; else printf wait; fi"],
        )
        if decoded(ready.stdout_b64) == b"ready":
            break
        time.sleep(0.1)
    binary_body = b"\x00\xff\x01\x80A"
    echoed = client.browsers.request(
        BROWSER_ID, "POST", "http://127.0.0.1:18766/echo", content=binary_body
    )
    assert echoed.content == binary_body
finally:
    client.browsers.process.kill(echo_server.process_id, id=BROWSER_ID, signal="TERM")

assert client.browsers.computer.capture_screenshot(BROWSER_ID).read()[:4] == b"\x89PNG"

if not browser.headless:
    replay = client.browsers.replays.start(BROWSER_ID, framerate=2, max_duration_in_seconds=3)
    time.sleep(0.7)
    client.browsers.replays.stop(replay.replay_id, id=BROWSER_ID)
    assert len(client.browsers.replays.download(replay.replay_id, id=BROWSER_ID).read()) > 1_000
else:
    try:
        client.browsers.replays.start(BROWSER_ID, framerate=2, max_duration_in_seconds=3)
    except Exception as error:
        assert getattr(error, "status_code", None) == 400
    else:
        raise AssertionError("headless replay unexpectedly started")
client.browsers.fs.delete_directory(BROWSER_ID, path=root)


async def async_checks() -> None:
    async with AsyncKernel(api_key=API_KEY, base_url=BASE_URL, timeout=180.0, max_retries=0) as async_client:
        async_profile = await async_client.profiles.create(name=f"python-async-profile-{resource_suffix}")
        try:
            assert (await async_client.profiles.retrieve(async_profile.id)).id == async_profile.id
        finally:
            await async_client.profiles.delete(async_profile.id)
        browser = await async_client.browsers.retrieve(BROWSER_ID)
        assert browser.session_id == BROWSER_ID
        result = await async_client.browsers.process.exec(BROWSER_ID, command="printf", args=["async-python"])
        assert decoded(result.stdout_b64) == b"async-python"
        direct = await async_client.browsers.request(BROWSER_ID, "GET", "https://example.com")
        assert direct.status_code == 200 and "Example Domain" in direct.text
        screenshot = await async_client.browsers.computer.capture_screenshot(BROWSER_ID)
        assert (await screenshot.read())[:4] == b"\x89PNG"


asyncio.run(async_checks())
print("PASS Kernel Python sync + async live parity")
