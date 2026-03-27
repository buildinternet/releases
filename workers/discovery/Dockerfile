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

# Default data dir for Released CLI
ENV RELEASED_DATA_DIR=/app/data
RUN mkdir -p /app/data
