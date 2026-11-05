#!/bin/sh
set -eu
node --test tests/image-core.test.mjs
node tests/check-project.mjs
