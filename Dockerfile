# Zero runtime dependencies — just node + the source.
FROM node:20-alpine

WORKDIR /app
COPY src ./src
COPY package.json ./

# Default entrypoint; GitLab CI overrides via `script:` but this lets you run
# the image directly: `docker run --rm -e ZAI_API_KEY=... -e ... image`
ENTRYPOINT ["node", "/app/src/index.js"]
