# Mapping the serverless tier to managed platforms

Documentation only. Nothing here was deployed or tested, and the pricing and product details
should be checked before relying on them.

The local activator plays the role a managed platform's front door plays: hold the request,
start the unit, wait until it can do useful work, forward. The ordering service stays
always-on in every mapping, for the reasons in the README.

## AWS

- Activator → API Gateway or a Lambda function URL. The platform's own cold start replaces
  `docker start`.
- Gateway → Lambda on the Node 22 runtime, or a container image.
  - Keep the gRPC client and Fabric `Gateway` objects at module scope so warm invocations reuse
    them, and reconnect after a freeze/thaw.
  - The function needs VPC access to the peers.
- Keys → Secrets Manager or KMS instead of the file wallet. PKCS#11 HSM access is not available
  inside Lambda.
- Cold-start mitigation → provisioned concurrency. SnapStart does not cover the managed Node
  runtime. SnapStart for container images was announced in July 2024 and needs checking.
- The single-use delivery table has to move to a shared store with a unique constraint, for
  example DynamoDB with a conditional put, because Lambda instances don't share a disk.

## Fly.io

- Peers → Fly Machines with volumes, `auto_stop_machines = "stop"`, `auto_start_machines = true`,
  `min_machines_running = 0`.
- Orderers → four apps with `auto_stop_machines = "off"`, ideally in different regions and run
  by different organizations.
- Private wake-ups need Flycast, because `.internal` 6PN traffic bypasses fly-proxy and so
  bypasses autostart. Fly documents Flycast as HTTP-only, so gRPC/TLS passthrough to peers is an
  open question.
- Certificate SANs must match the Fly DNS names.
- Stopped Machines are billed for storage only. `suspend` keeps memory, which is closer to the
  `pause` strategy measured locally than to `stop`.

## What the local numbers do and don't say

E1 and E4 measure Docker containers on one laptop VM. A managed platform adds its own cold
start (image fetch, VM boot) and bills differently. The measurements show which components can
sleep, what it costs to wake the endorsement path, and how much idle memory-time that saves. They
are not a price quote.
