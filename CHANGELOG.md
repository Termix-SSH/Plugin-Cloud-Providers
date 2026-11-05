# Changelog

## 1.2.0

### Added

- Sync a cloud account through Termix actions, so a rule, rollout or the CLI can run it, and see failing syncs as a status tile

### Changed

- Needs Termix 26.11.1 or newer
- The accounts page and its forms use the Termix page header and tile look

### Fixed

- Password fields with the show button are the same height as the other fields next to them

## 1.1.0

### Added

- Cloud accounts dashboard card: each account with when it last synced or why it failed, and Sync now

## 1.0.0

### Added

- Cloud accounts for AWS (EC2 and Lightsail), Azure, Google Cloud, DigitalOcean, Hetzner, Linode, Vultr, Oracle Cloud, Scaleway and UpCloud
- Import chosen servers as hosts, or sync a whole account by hand or on a timer
- Hosts follow name and IP changes, with an option to keep, tag or delete hosts whose server is gone
