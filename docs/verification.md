# Verification log

What was run, when, and on what. Dates here are the real run dates from each result file's
manifest (`recorded_at` / `ran_at`); commit timestamps in this repository's history were
rewritten and are not evidence of when anything ran. No provider API keys are used anywhere in
this project.

## Unit tests (no network)

Run on every change; last full pass on 2024-09-25 against the tree at the time of the final
report:

- `cd chaincode/ehr && go test -mod=mod ./... -cover` (contract package ~82% coverage)
- `cd activator && go test ./... -race -cover`
- `pnpm -r lint` and `pnpm -r test` (gateway, UI, experiments harness), `pnpm -C ui build`
- CI repeats the TypeScript tests in a `--network none` container.

## Live network runs

Each ran as one unattended `scripts/lease-run.sh` call under the shared compute lease: bring the
Fabric network up, run the phases, write results, tear down.

| Date (local) | Phases | Result files | Outcome |
|---|---|---|---|
| 2024-09-23 | first-hour spike (`network/spike.sh`) | none | stock asset-transfer-basic on BFT committed with one orderer stopped |
| 2024-09-24 | e2e, bft demo, E2, E3 | `e2e.json`, `bft-demo.json`, `throughput.json`, `faults.json` (E3 later superseded) | e2e 27/27; see README |
| 2024-09-24 | app tier, E1, screenshots | `coldstart.json`, desktop screenshots | all trials HTTP 200 |
| 2024-09-24 | app tier, E4 (600 s × 3) | `idle.json` | see README |

Earlier live runs on 2024-09-23 and 2024-09-24 found and fixed live-only bugs:
- contract-api's return schema treated `omitempty` fields as required;
- google-protobuf's CommonJS export under Node ESM;
- the peer Deliver service returning 404 for a start block beyond its height;
- the Raft channel's anchor-peer update before leader election.

Their result files were not kept.

## Not verified here

- Any cloud deployment (AWS, Fly): documentation only.
- An egress-blocked runtime for the Fabric stack: only the unit tests are shown to need no network.
- Mobile screenshots before 2024-09-25 (layout fixes were checked with the design reviewer's mocked-API Playwright scripts at 390 px; every page fit the viewport width).
