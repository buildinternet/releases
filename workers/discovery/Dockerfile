FROM docker.io/cloudflare/sandbox:0.8.0

# Cache bust: force image rebuild
ENV RELEASED_BUILD_VERSION=2

# Install Bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:$PATH"

# Copy project and install deps
COPY . /app
WORKDIR /app
RUN bun install --frozen-lockfile

# Place agent skills where the Agent SDK discovers them
RUN mkdir -p /app/.claude/skills && cp -r /app/src/agent/skills/* /app/.claude/skills/

# Sandbox SDK command timeout — 5 minutes for agent runs
ENV COMMAND_TIMEOUT_MS=300000

# Default data dir for Released CLI
ENV RELEASED_DATA_DIR=/app/data
RUN mkdir -p /app/data

# Expose WebSocket port for log streaming
EXPOSE 8081
