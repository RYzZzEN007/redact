# ---- Redact: Node + Python + ffmpeg in one image ----
FROM node:20-slim

# System deps: Python, pip, and ffmpeg (for the CV worker + video encode)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# --- Python worker deps ---
# Copy just requirements first so this layer caches unless requirements change
COPY python/requirements.txt ./python/requirements.txt
RUN pip3 install --no-cache-dir --break-system-packages -r python/requirements.txt

# --- Node deps for the server ---
COPY server/package*.json ./server/
RUN cd server && npm install --omit=dev

# --- Build the React frontend ---
COPY client/package*.json ./client/
RUN cd client && npm install
COPY client ./client
RUN cd client && npm run build

# --- Copy the rest (worker.py, models, server code) ---
COPY python ./python
COPY server ./server

# The container runs system python3, not a venv
ENV PYTHON_BIN=python3
# Azure sets PORT; default to 3001 locally
ENV PORT=3001
EXPOSE 3001

CMD ["node", "server/index.js"]