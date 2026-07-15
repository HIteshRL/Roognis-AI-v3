# RAG Service / EKE LLD

Service path: `services/rag`

Detailed ingestion contract: `docs/backend-services/RAG_EKE_INGESTION_CONTRACT.md`

## Purpose

RAG owns curriculum context and will evolve into the Educational Knowledge Engine (EKE):

- document ingestion
- educational entity extraction
- canonical concept mapping
- entity relationship storage
- chunking
- embedding
- vector storage
- retrieval for chat
- retrieval for lesson-based quiz generation

Without EKE-backed retrieval, chat and quizzes can run technically but will not be curriculum-grounded.

## Current Repo State

Implemented:

- `GET /health`
- `GET /api/rag/retrieve`

Current retrieve endpoint returns empty chunks.

## Gaps

Missing:

- PDF upload.
- Document status.
- Document lifecycle persistence.
- Educational entity table.
- Entity relationship table.
- Retrieval chunk table.
- Canonical concept mapping.
- Embedding generation.
- ChromaDB collection writes.
- Lesson mapping.
- Lesson-context retrieval for Quiz Service / AI.
- JWT middleware for teacher document management.

## APIs

```text
POST /api/rag/upload
GET  /api/rag/upload/:docId/status
GET  /api/rag/documents
GET  /api/rag/retrieve?q=...&schoolId=...&subject=...&top=...
GET  /api/rag/lessons/:lessonId/context?top=...
```

Note: older docs mention `POST /api/rag/documents`. If retained, it should be an alias for `POST /api/rag/upload`.

### `POST /api/rag/upload`

Role: teacher

Upload a PDF and required curriculum metadata.

Content type:

```text
multipart/form-data
```

Required metadata:

```json
{
  "board": "CBSE",
  "curriculum": "NCERT",
  "grade": 8,
  "subject": "Science",
  "book": "Curiosity",
  "chapterNumber": 10,
  "chapterName": "Light: Mirrors and Lenses",
  "language": "English",
  "edition": "2026-27"
}
```

Response:

```json
{
  "documentId": "uuid",
  "status": "queued",
  "metadata": {
    "schoolId": "uuid",
    "grade": 8,
    "subject": "Science",
    "chapterNumber": 10,
    "chapterName": "Light: Mirrors and Lenses"
  }
}
```

### `GET /api/rag/upload/:docId/status`

Role: teacher

Response:

```json
{
  "documentId": "uuid",
  "status": "embedding",
  "progress": {
    "stage": "embedding",
    "percent": 74,
    "pagesParsed": 18,
    "entitiesCreated": 96,
    "chunksCreated": 42,
    "chunksEmbedded": 31
  },
  "errorMessage": null
}
```

### `GET /api/rag/retrieve`

Caller:

- AI Service

Query:

```text
q=photosynthesis
schoolId=uuid
subject=Science
top=5
```

Response:

```json
{
  "chunks": [
    {
      "chunkId": "uuid",
      "entityId": "uuid",
      "canonicalConceptId": "uuid",
      "text": "Plants make food by photosynthesis...",
      "source": "NCERT Science Grade 6",
      "score": 0.84,
      "metadata": {
        "schoolId": "uuid",
        "grade": 6,
        "subject": "Science",
        "chapterNumber": 1,
        "entityType": "Concept",
        "pageStart": 42
      }
    }
  ]
}
```

Compatibility requirement:

- The AI service currently needs `text`, `source`, and optional `score`.
- Return `{ "chunks": [] }` for empty retrieval.
- Do not return fake context.

### `GET /api/rag/lessons/:lessonId/context`

Caller:

- AI Service quiz generation path

Why:

- Teacher selects lesson first.
- Lesson context is more reliable than free-text search.

Response:

```json
{
  "lessonId": "uuid",
  "chunks": [
    {
      "chunkId": "uuid",
      "text": "...",
      "source": "NCERT Science Grade 6",
      "page": 42
    }
  ]
}
```

## Data Model

Use SQLAlchemy as planned in previous docs, or switch to Prisma only if the team wants all services on one DB tool. Do not mix both inside one service.

Minimum tables:

```text
documents
  id
  school_id
  board
  curriculum
  subject
  grade
  book
  chapter_number
  chapter_name
  language
  edition
  title
  file_path
  status
  error_message
  created_by
  created_at
  updated_at

document_ingestion_events
  id
  document_id
  status
  message
  metadata_json
  created_at

educational_entities
  id
  document_id
  school_id
  entity_type
  canonical_concept_id
  title
  content
  summary
  metadata_json
  parent_id
  created_at
  updated_at

entity_relationships
  id
  source_entity_id
  target_entity_id
  relationship_type
  confidence
  metadata_json
  created_at

retrieval_chunks
  id
  document_id
  entity_id
  canonical_concept_id
  school_id
  board
  curriculum
  subject
  grade
  chapter_number
  chapter_name
  chunk_index
  text
  source
  source_page
  metadata_json
  vector_id
  created_at
```

Entity types:

```text
CanonicalConcept
Concept
Definition
Activity
Experiment
Observation
Conclusion
Example
Application
Figure
Diagram
Table
Summary
Law
Formula
Exercise
Question
Safety
Extension
KeyPoint
```

## Chroma Collection Strategy

MVP:

```text
school_{schoolId}_{subject}
```

Metadata per vector:

```json
{
  "schoolId": "uuid",
  "board": "CBSE",
  "curriculum": "NCERT",
  "subject": "Science",
  "grade": 6,
  "documentId": "uuid",
  "entityId": "uuid",
  "chunkId": "uuid",
  "chapterNumber": 1,
  "entityType": "Concept",
  "page": 42
}
```

Filters must be applied before vector retrieval where supported.

## MVP Shortcut

Before full PDF ingestion, seed one or two lesson contexts:

- Science / Class 6 / Plants and nutrition
- Maths / Class 6 / Fractions

This is enough to test:

- tutor chat grounding
- teacher quiz generation
- weak-area questions

## Done Criteria

- RAG returns non-empty chunks for seeded lessons.
- AI chat receives context for seeded topics.
- AI quiz generation receives lesson context.
- Missing context returns explicit empty result, not fake data.

## Tests

- retrieve returns chunks for seeded lesson.
- unknown lesson returns empty chunks.
- top parameter is respected.
- teacher document APIs require teacher role.
- school isolation works.

