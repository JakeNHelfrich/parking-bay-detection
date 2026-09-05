# Single-container build: frontend + backend served from one origin.
#
# Stage 1 builds the Vite frontend (no VITE_DETECT_WS_URL needed — the app
# derives its WS URL from location at runtime, so it works same-origin).
# Stage 2 installs the Python service (with CPU-only torch), bakes in the
# trained weights, and copies the frontend build in to be served by FastAPI
# at "/" (see app/main.py _mount_frontend / PARKING_STATIC_DIR).

# --- Stage 1: frontend build -------------------------------------------------
FROM node:22-alpine AS frontend-build
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build   # tsc + vite build -> dist/

# --- Stage 2: runtime ---------------------------------------------------------
FROM python:3.12-slim AS runtime

# opencv (pulled in by ultralytics) needs libGL; libglib is a pillow/opencv dep.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv

# CPU-only torch + matching torchvision first, so ultralytics doesn't pull the
# (much larger) CUDA builds. Installing them together from the CPU index keeps
# versions compatible (mismatched torchvision breaks torchvision::nms).
RUN pip install --no-cache-dir torch torchvision --index-url https://download.pytorch.org/whl/cpu

COPY server/pyproject.toml ./
COPY server/app ./app
RUN pip install --no-cache-dir ".[model]"

# Trained weights baked into the image (NOT downloaded at startup, so /health
# never depends on network at boot).
COPY server/simtruck.pt /srv/models/simtruck.pt

# Frontend build served by FastAPI (PARKING_STATIC_DIR points here).
COPY --from=frontend-build /build/dist /srv/static

ENV PARKING_DETECTOR=yolo \
    PARKING_MODEL_NAME=/srv/models/simtruck.pt \
    PARKING_STATIC_DIR=/srv/static \
    PARKING_HOST=0.0.0.0 \
    PARKING_PORT=8080

EXPOSE 8080
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
