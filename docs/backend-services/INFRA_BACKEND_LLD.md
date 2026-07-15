# Backend Infrastructure LLD

Scope:

- Docker Compose
- Traefik routes
- Kubernetes manifests
- service environment variables
- local development startup

## Current Repo State

Current services in `docker-compose.yml`:

- `traefik`
- `postgres`
- `chromadb`
- `ollama` optional profile
- `comfyui` optional profile
- `auth`
- `ai`
- `rag`
- `analytics`
- `frontend`

Missing:

- `quiz` service.

## Docker Compose Changes

Add `quiz` service:

```yaml
quiz:
  build: ./services/quiz
  command: >
    sh -c "[ -f prisma/schema.prisma ] &&
           npx prisma db push --schema=prisma/schema.prisma ||
           true && node server.js"
  environment:
    DATABASE_URL: "postgresql://postgres:${DB_PASSWORD}@postgres:5432/roognis?schema=quiz_db"
    JWT_SECRET: ${JWT_SECRET}
    AI_SERVICE_URL: "http://ai:3002"
    AUTH_SERVICE_URL: "http://auth:3001"
    ANALYTICS_URL: "http://analytics:3004"
    PORT: 3005
    NODE_ENV: production
  depends_on:
    postgres:
      condition: service_healthy
    ai:
      condition: service_started
    analytics:
      condition: service_started
  labels:
    - "traefik.enable=true"
    - "traefik.http.routers.quiz.rule=PathPrefix(`/api/quiz`)"
    - "traefik.http.routers.quiz.entrypoints=web"
    - "traefik.http.services.quiz.loadbalancer.server.port=3005"
    - "traefik.http.routers.quiz.middlewares=cors@file"
  restart: unless-stopped
```

## Environment Variables

Add to `.env.example`:

```text
QUIZ_SERVICE_URL=http://quiz:3005
AI_SERVICE_URL=http://ai:3002
AUTH_SERVICE_URL=http://auth:3001
```

Quiz service:

```text
DATABASE_URL=postgresql://...
JWT_SECRET=...
AI_SERVICE_URL=http://ai:3002
AUTH_SERVICE_URL=http://auth:3001
ANALYTICS_URL=http://analytics:3004
PORT=3005
```

## Traefik

Docker labels are enough for local compose.

New route:

```text
/api/quiz -> quiz:3005
```

## Kubernetes Changes

Add files:

```text
kubernetes/quiz/deployment.yaml
kubernetes/quiz/service.yaml
```

Update:

```text
kubernetes/kustomization.yaml
kubernetes/ingress/ingress.yaml
kubernetes/secrets/README.md
```

Ingress addition:

```yaml
- path: /api/quiz
  pathType: Prefix
  backend:
    service:
      name: quiz
      port:
        number: 3005
```

Quiz deployment sketch:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: quiz
  namespace: roognis
spec:
  replicas: 2
  selector:
    matchLabels:
      app: quiz
  template:
    metadata:
      labels:
        app: quiz
    spec:
      initContainers:
        - name: db-migrate
          image: roognis/quiz:latest
          command: ["sh", "-c", "[ -f prisma/schema.prisma ] && npx prisma db push --schema=prisma/schema.prisma || true"]
          envFrom:
            - secretRef:
                name: quiz-secrets
      containers:
        - name: quiz
          image: roognis/quiz:latest
          command: ["node", "server.js"]
          ports:
            - containerPort: 3005
          envFrom:
            - secretRef:
                name: quiz-secrets
          env:
            - name: PORT
              value: "3005"
            - name: NODE_ENV
              value: production
```

## Current Infra Risks

1. `chromadb/chroma:latest` is unpinned and already caused local pull issues.
2. `prisma db push` is acceptable for MVP but should become migrations before production.
3. Kubernetes Auth deployment currently uses `node scripts/seed.js` as main command and `postStart` to start server; that is risky.
4. K8s secrets README still mentions old provider names like `ANTHROPIC_API_KEY`; Gemini values need to be documented.
5. Frontend Dockerfile still serves static prototype, not a real app.
6. RAG requirements file does not exist, so Dockerfile currently installs nothing.

## Auth K8s Startup Fix

Current pattern should be replaced with:

```yaml
command: ["sh", "-c", "node scripts/seed.js && node server.js"]
```

Longer term:

- seed should be a one-off job
- migrations should be explicit
- app container should only start the server

## Done Criteria

- `docker-compose up --build` includes Quiz Service.
- `/api/quiz/health` routes through Traefik.
- K8s ingress includes `/api/quiz`.
- Secrets README includes quiz and Gemini env values.
- Auth K8s startup is corrected.

