#!/usr/bin/env bash
# Build and publish to S3 + CloudFront (us-east-1).
set -euo pipefail
BUCKET=redlines-heatlines-nyc-2026
DIST_ID=E2E3NHVH3GCO6N
cd "$(dirname "$0")"
npm run build
aws s3 sync dist "s3://$BUCKET" --delete --exclude index.html --exclude 'data/*' --cache-control 'public,max-age=31536000,immutable'
aws s3 sync dist/data "s3://$BUCKET/data" --delete --cache-control 'public,max-age=3600'
aws s3 cp dist/index.html "s3://$BUCKET/index.html" --cache-control 'no-cache'
aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths '/index.html' '/data/*' >/dev/null
echo "Live: https://d2qzucm1xjsw12.cloudfront.net/"
