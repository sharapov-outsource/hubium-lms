# Security policy

Please report vulnerabilities privately through GitHub: **Security → Report a vulnerability** on this repository. Include steps to reproduce. Do not open public issues for security problems.

We acknowledge reports within three working days and aim to release a fix within 30 days for high-severity issues. Supported versions: the latest release on `main`.

See [docs/security.md](docs/security.md) for the protections built into Hubium.

Release files are listed with their checksums in `SHA256SUMS`, and the archives carry signed build provenance: `gh attestation verify <archive> --repo sharapov-outsource/hubium-lms` ([docs/releasing.md](docs/releasing.md)).
