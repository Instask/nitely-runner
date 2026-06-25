# Nitely Runner

Future customer-hosted runner daemon for Nitely.

This repository is reserved for a separately released runner process if the
runner needs a lifecycle independent from the open source `nitely` core.

Likely responsibilities:

- connect to a control plane;
- receive authorized run work;
- execute Nitely core flows in a customer-owned environment;
- stream status, logs, evidence, and artifacts back to the coordinator;
- preserve local secret and repository boundaries.

This should stay aligned with the open-core trust model. The runner may become
open source because it sits on the trust boundary between customer code and the
hosted control plane.

Current status: reserved scaffold. Implementation should wait for the
customer-hosted runner design work.
