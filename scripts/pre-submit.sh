#!/usr/bin/env bash
set -e

echo "========================================="
echo "  Bahikhata Pre-Submit Checklist"
echo "========================================="

echo -e "\n1. Checking for secrets..."
# Exclude node_modules, .git, dist, data, generated
if grep -r -i -E "rzp_""live|sk-""ant-" --exclude-dir={node_modules,.git,dist,data,generated} .; then
  echo "❌ SECRETS FOUND! Aborting."
  exit 1
else
  echo "✓ No secrets found."
fi

echo -e "\n2. Verifying .gitignore..."
if grep -q "\.env" .gitignore && grep -q "data/\*\.db" .gitignore; then
  echo "✓ .gitignore is properly configured."
else
  echo "❌ .gitignore is missing .env or data/*.db"
  exit 1
fi

echo -e "\n3. Running unit & integration tests..."
npm test

echo -e "\n4. Running Demo Pipeline (--seed 42 --records 500)..."
npm run demo -- --seed 42 --records 500

echo -e "\n5. Testing Docker Build..."
if command -v docker >/dev/null 2>&1; then
  docker build -t bahikhata:test .
  echo "✓ Docker build successful."
else
  echo "⚠️ Docker is not installed, skipping Docker build test."
fi

echo -e "\n========================================="
echo "  ALL PRE-SUBMIT CHECKS PASSED ✓"
echo "========================================="
