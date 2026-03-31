FROM docker.io/cloudflare/sandbox:0.8.0

# Copy compiled binaries
COPY dist/released /usr/local/bin/released
COPY dist/released-mcp-browser /usr/local/bin/released-mcp-browser

# Skills live at the conventional path and are also pre-placed where the
# Agent SDK discovers them (the SDK checks before ensureSkillsDiscoverable runs)
COPY src/agent/skills/ /usr/share/released/skills/
RUN mkdir -p /app/.claude/skills && cp -r /usr/share/released/skills/* /app/.claude/skills/

# Sandbox SDK command timeout — 5 minutes for agent runs
ENV COMMAND_TIMEOUT_MS=300000

# Default data dir
ENV RELEASED_DATA_DIR=/app/data
RUN mkdir -p /app/data

EXPOSE 8081
