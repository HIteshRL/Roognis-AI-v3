# Secrets

Never commit real secrets to this folder.

Create secrets manually before applying the kustomization.
Replace `<DB_HOST>`, `<DB_USER>`, `<DB_PASS>` with your actual RDS values.

> **Auth removed.** The auth service is gone and no service verifies a JWT, so
> there is no `JWT_SECRET` and no `auth-secrets`. Every endpoint is open. The
> `DEMO_*` ids below are the fixed tenant the services fall back to now that
> nothing identifies the caller — they are not credentials.

```sh
# AI service
kubectl create secret generic ai-secrets \
  --namespace roognis \
  --from-literal=DATABASE_URL="postgresql://<DB_USER>:<DB_PASS>@<DB_HOST>/roognis?schema=ai_db" \
  --from-literal=INTERNAL_SERVICE_TOKEN="<same as analytics>" \
  --from-literal=DEMO_SCHOOL_ID="00000000-0000-0000-0000-000000000001" \
  --from-literal=DEMO_STUDENT_ID="00000000-0000-0000-0000-000000000002" \
  --from-literal=OLLAMA_URL="http://ollama:11434" \
  --from-literal=ANTHROPIC_API_KEY="" \
  --from-literal=AWS_S3_BUCKET="" \
  --from-literal=AWS_ACCESS_KEY_ID="" \
  --from-literal=AWS_SECRET_ACCESS_KEY=""

# Analytics service
kubectl create secret generic analytics-secrets \
  --namespace roognis \
  --from-literal=DATABASE_URL="postgresql://<DB_USER>:<DB_PASS>@<DB_HOST>/roognis?schema=analytics_db" \
  --from-literal=INTERNAL_SERVICE_TOKEN="<shared internal token>" \
  --from-literal=DEMO_SCHOOL_ID="00000000-0000-0000-0000-000000000001" \
  --from-literal=DEMO_STUDENT_ID="00000000-0000-0000-0000-000000000002" \
  --from-literal=DEMO_TEACHER_ID="00000000-0000-0000-0000-000000000003"

# Classroom service (LMS)
kubectl create secret generic classroom-secrets \
  --namespace roognis \
  --from-literal=DATABASE_URL="postgresql://<DB_USER>:<DB_PASS>@<DB_HOST>/roognis?schema=classroom_db" \
  --from-literal=DEMO_SCHOOL_ID="00000000-0000-0000-0000-000000000001" \
  --from-literal=DEMO_STUDENT_ID="00000000-0000-0000-0000-000000000002" \
  --from-literal=DEMO_TEACHER_ID="00000000-0000-0000-0000-000000000003"

# RAG service
kubectl create secret generic rag-secrets \
  --namespace roognis \
  --from-literal=DATABASE_URL="postgresql://<DB_USER>:<DB_PASS>@<DB_HOST>/roognis" \
  --from-literal=CHROMA_URL="http://chromadb:8000" \
  --from-literal=DEMO_SCHOOL_ID="00000000-0000-0000-0000-000000000001" \
  --from-literal=DEMO_TEACHER_ID="00000000-0000-0000-0000-000000000003" \
  --from-literal=PINECONE_API_KEY="" \
  --from-literal=PINECONE_ENV=""

# PostgreSQL (only needed if not using RDS)
kubectl create secret generic postgres-secrets \
  --namespace roognis \
  --from-literal=POSTGRES_PASSWORD="$(openssl rand -hex 16)"
```

In production, use Sealed Secrets or AWS Secrets Manager + External Secrets Operator instead of `kubectl create secret`.
