# Multiple GPU agent churn test

Eight agents each continuously fork a short-lived GPU VM, run a Claude Code
workflow (testing features of vLLM) inside it that generates and runs tests of
critical vLLM features, then delete the VM.
This demonstrate how agents can utilize sliced GPU, coding harness, and credentails
set using outbound network policies so that agents never see it.

## Setup

```bash
export ARKER_API_KEY=<your-arker-api-key>
export ARKER_ANTHROPIC_API_KEY=sk-ant-...             # your own anthropic API key,
                                                      # injected by policy, never seen by a guest
```

## Run

```bash
./launch.py --minutes 10 --threads 8 --tests-per-agent 3
```

## Tear down

No need to tear down. The test harness will clean up all VMs created by the test.