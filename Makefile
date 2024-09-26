SHELL := bash
export GOTOOLCHAIN := local
COMPOSE := docker compose -f compose.app.yaml --env-file .env

.PHONY: setup bootstrap test test-go test-ts lint build network-up network-down app-build app-up app-down \
        gateways-host e2e bft-demo exp-coldstart exp-throughput exp-faults exp-idle exp-report down

.env:
	cp .env.example .env

setup: .env
	pnpm install --frozen-lockfile
	cd chaincode/ehr && go mod download
	cd activator && go mod download

bootstrap:
	network/bootstrap.sh

test: test-go test-ts

test-go:
	cd chaincode/ehr && go test -mod=mod ./... -cover
	cd activator && go test ./... -race -cover

test-ts:
	pnpm -r test

lint:
	cd chaincode/ehr && go vet -mod=mod ./... && test -z "$$(find . -path ./vendor -prune -o -name '*.go' -print0 | xargs -0 gofmt -l)"
	cd activator && go vet ./... && test -z "$$(gofmt -l .)"
	pnpm -r lint

build:
	pnpm -C gateway build
	pnpm -C ui build

# Fabric network: BFT + Raft channels, chaincode, read replica, seeded users (~4 min).
network-up: .env
	network/all-up.sh

network-down down:
	network/down.sh

app-build:
	$(COMPOSE) build

# Activator and UI run; both gateways are created but stopped, so the first request is cold.
app-up: .env
	$(COMPOSE) up -d activator ui
	$(COMPOSE) create org1-api org2-api

app-down:
	$(COMPOSE) down --remove-orphans

# Gateways on the host for the e2e: org1, org2, the org1 read-replica gateway, and a
# FRESHNESS=off control on the replica.
gateways-host: .env
	scripts/gateways-host.sh

e2e: .env
	set -a; source .env; set +a; pnpm -C gateway e2e

bft-demo:
	network/bft-demo.sh

exp-coldstart:
	pnpm -C experiments coldstart
exp-throughput:
	pnpm -C experiments throughput
exp-faults:
	pnpm -C experiments faults
exp-idle:
	pnpm -C experiments idle
exp-report:
	pnpm -C experiments report
