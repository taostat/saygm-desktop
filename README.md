<p align="center">
  <img src="ui/desktop/src/images/saygm-mark.svg" alt="SayGM" width="64" />
</p>

# SayGM Desktop

SayGM Desktop brings the Goose desktop agent to your SayGM account. Sign in, choose supported SayGM models, check your balance, and manage local tool approvals and SayGM guardrail controls.

It is a private, product-specific distribution of [Goose](https://github.com/aaif-goose/goose). Goose's Apache License 2.0 and upstream notices are retained in this repository. See [source provenance](SAYGM_BUILD_PROVENANCE.md) and the [upstream README](UPSTREAM_README.md).

## Downloads

Latest release: `0.1.0-beta.1`.

| Platform | Availability |
| --- | --- |
| macOS Apple Silicon | Published; signed and notarized. |
| Windows x64 | Published; unsigned. |
| Ubuntu x64 and ARM64 | Published. |

Download available assets from the [GitHub Releases page](https://github.com/taostat/saygm-desktop/releases). The repository is private, so viewing or downloading releases requires access to `taostat/saygm-desktop`.

## Development

Activate the pinned toolchain with `source bin/activate-hermit`. The desktop uses Node 24.10 and pnpm 10.30.3.

```sh
cd ui
pnpm install --frozen-lockfile
cd desktop
pnpm run typecheck
pnpm test:run
```

The backend lives in `crates/`; the desktop lives in `ui/desktop/`. Production account API: `https://account.saygm.com/v1`. Inference API: `https://api.saygm.com/v1`.

For Goose updates and downstream architecture, see [Maintaining Goose](maintenance/UPSTREAM.md). This repository retains Goose's license and notices; its private release workflows publish SayGM builds only and do not publish to the upstream Goose repository.
