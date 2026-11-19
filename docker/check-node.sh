#!/bin/sh
set -eu
node --test tests/image-core.test.mjs
node --test tests/sse-core.test.mjs
node --test tests/wedding-assets.test.mjs
node --test tests/phase7-evaluation.test.mjs
node scripts/verify-wedding-assets.mjs tests/fixtures/wedding-assets-manifest.json
node scripts/verify-wedding-assets.mjs assets/wedding/manifest.json
node tests/check-project.mjs
