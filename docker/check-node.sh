#!/bin/sh
set -eu
for source in web/*.mjs tests/*.mjs; do node --check "$source"; done
node --test tests/image-core.test.mjs
node --test tests/sse-core.test.mjs
node --test tests/headroom-core.test.mjs
node --test tests/wedding-assets.test.mjs
node --test tests/phase7-evaluation.test.mjs
node --test tests/public-assets.test.mjs
node scripts/verify-wedding-assets.mjs tests/fixtures/wedding-assets-manifest.json
node scripts/verify-wedding-assets.mjs assets/wedding/manifest.json
node tests/check-project.mjs
