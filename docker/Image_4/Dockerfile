FROM debian:bookworm-slim

LABEL org.opencontainers.image.title="C/C++"
LABEL org.opencontainers.image.description="C/C++ development environment with build-essential, gcc, g++, cmake, gdb, and Python3."

# ------------------------------------------------------------
# Disable interactive apt prompts and install essentials
# ------------------------------------------------------------
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    gcc \
    g++ \
    make \
    cmake \
    gdb \
    python3 \
    python3-pip \
    python3-venv \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# ------------------------------------------------------------
# Set working directory
# ------------------------------------------------------------
WORKDIR /app

# ------------------------------------------------------------
# Optional: Add Python-based C++ utilities (for hybrid use)
# Use a venv to avoid Debian's PEP 668 externally-managed restriction
# ------------------------------------------------------------
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --upgrade pip \
    && /opt/venv/bin/pip install --no-cache-dir conan

# Put venv on PATH so conan and python are available globally
ENV PATH="/opt/venv/bin:${PATH}"

# ------------------------------------------------------------
# Keep container running (for interactive sessions)
# ------------------------------------------------------------
ENTRYPOINT ["bash", "-c"]
CMD ["tail -f /dev/null"]