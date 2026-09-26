# CRM PC release downloads

Worker `vetclinic-crm-downloads` serves immutable release files from the private R2 bucket
`vetclinic-crm-releases` at `https://vetclinic.vn/tai-ve/crm-pc/v3/`.

Release order is mandatory:

1. Upload the versioned installer, update ZIP, and `SHA256SUMS.txt` under the `v3/` key prefix.
2. Download them through the public URL and verify their SHA-256 values.
3. Upload `manifest.json.sig`.
4. Upload `manifest.json` last; this publishes the release to clients.

`manifest.json` and its signature are always served with `no-store`; versioned packages are immutable.
The legacy `/tai-ve/crm-pc/manifest.json` route is intentionally not handled by this Worker.
